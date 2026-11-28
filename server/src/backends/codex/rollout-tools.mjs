import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";
import { codexRolloutUsage } from "./token-usage.mjs";

const inputs = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
  "web_search_call",
  "image_generation_call",
]);
const outputs = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
]);
const traceItems = new Set([
  "agentMessage",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

function recordPosition(trace, id, time, sequence) {
  const previous = trace.positions.get(id);
  if (!previous || time < previous.time)
    trace.positions.set(id, { time, sequence });
}

function fileChanges(changes) {
  if (Array.isArray(changes))
    return changes.map(({ path, kind }) => ({ path, kind }));
  return Object.entries(changes).map(([path, { type, move_path }]) => ({
    path,
    kind: type === "update" ? { type, move_path } : { type },
  }));
}

async function scan(path, threadId, turnIds, onlyCallId, options) {
  const { callsOnly, outputMatches, usage, endByteOffset } = options;
  const matches =
    typeof onlyCallId === "function" ? onlyCallId : (id) => id === onlyCallId;
  const source = createReadStream(path);
  const input = path.endsWith(".zst")
    ? source.pipe(createZstdDecompress())
    : source;
  if (source !== input) source.on("error", (error) => input.destroy(error));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const turns = new Map();
  let turnId;
  let identified = false;
  let sequence = 0;
  let time = 0;
  let bytes = 0;
  let context = { compactCount: 0 };
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      if (endByteOffset != null && bytes > endByteOffset) break;
      sequence++;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // An active rollout may end with a partially persisted line.
        continue;
      }
      const { type, payload } = record ?? {};
      if (!payload || typeof payload !== "object") continue;
      const timestamp = Date.parse(record.timestamp);
      if (Number.isFinite(timestamp)) time = timestamp;
      if (!identified) {
        if (type !== "session_meta" || payload.id !== threadId) {
          if (usage) throw new Error("Codex rollout 与对话标识不一致");
          return new Map();
        }
        identified = true;
        if (usage && payload.history_base)
          for (const [id, trace] of await usage.readBase(payload.history_base))
            turns.set(id, trace);
        continue;
      }
      if (
        type === "turn_context" ||
        (type === "event_msg" && payload.type === "task_started")
      )
        turnId = payload.turn_id;
      if (type === "compacted")
        context = {
          totalTokens: context.totalTokens,
          compactCount: context.compactCount + 1,
        };
      const { tokenUsage } = codexRolloutUsage(record);
      if (tokenUsage && !usage)
        context = {
          ...context,
          usedTokens: tokenUsage.last.totalTokens,
          totalTokens: tokenUsage.modelContextWindow ?? context.totalTokens,
        };
      if (
        type === "event_msg" &&
        ["task_complete", "turn_aborted"].includes(payload.type)
      )
        turnId = undefined;
      const owner =
        payload.internal_chat_message_metadata_passthrough?.turn_id ??
        payload.turn_id ??
        turnId;
      if (usage) {
        if (type === "compacted") usage.compacted(owner);
        if (type === "event_msg" && payload.type === "thread_rolled_back")
          for (const id of usage.rollback(payload.num_turns)) turns.delete(id);
        const snapshot = usage.observe(owner, tokenUsage);
        if (turnIds.has(owner)) turns.set(owner, snapshot);
        continue;
      }
      if (!turnIds.has(owner)) continue;
      if (!turns.has(owner))
        turns.set(owner, {
          calls: new Map(),
          items: new Map(),
          positions: new Map(),
        });
      const trace = turns.get(owner);
      trace.context = context;

      if (
        type === "event_msg" &&
        ["item_started", "item_completed"].includes(payload.type)
      ) {
        const item = payload.item;
        if (!item?.id || (onlyCallId && !matches(item.id))) continue;
        if (typeof item.type !== "string") continue;
        const kind = item.type.charAt(0).toLowerCase() + item.type.slice(1);
        if (
          !traceItems.has(kind) ||
          (callsOnly && ["agentMessage", "plan"].includes(kind))
        )
          continue;
        const start = payload.started_at_ms;
        recordPosition(
          trace,
          item.id,
          Number.isFinite(start) ? start : time,
          sequence,
        );
        trace.items.set(item.id, {
          id: item.id,
          type: kind,
          phase: item.phase,
          text: item.text,
          command: item.command,
          status: item.status,
          tool: item.tool,
          server: item.server,
          path: item.path,
          query: item.query,
          ...(kind === "fileChange" &&
            item.changes && { changes: fileChanges(item.changes) }),
        });
        continue;
      }

      if (type !== "response_item") continue;
      if (
        !onlyCallId &&
        !callsOnly &&
        payload.type === "message" &&
        payload.role === "assistant"
      ) {
        const id = payload.id ?? "rollout-message-" + sequence;
        recordPosition(trace, id, time, sequence);
        const text = payload.content?.map(({ text }) => text ?? "").join("");
        if (text?.trim())
          trace.items.set(id, {
            id,
            type: "agentMessage",
            phase: payload.phase,
            text,
          });
        continue;
      }
      if (!inputs.has(payload.type) && !outputs.has(payload.type)) continue;
      const callId =
        payload.call_id ?? (inputs.has(payload.type) && payload.id);
      if (!callId || (onlyCallId && !matches(callId))) continue;
      if (inputs.has(payload.type)) {
        recordPosition(trace, callId, time, sequence);
        trace.calls.set(callId, {
          callId,
          input: record,
          ...((onlyCallId || outputMatches?.(callId)) && { outputs: [] }),
        });
      } else {
        const call = trace.calls.get(callId);
        if (!call) continue;
        call.returned = true;
        call.outputs?.push(record);
      }
    }
    return turns;
  } finally {
    lines.close();
    source.destroy();
    input.destroy();
  }
}

export async function readRolloutTrace(thread, turnIds, callId, options = {}) {
  if (!thread.path) {
    if (options.usage) throw new Error("Codex 对话没有原生 rollout 路径");
    return new Map();
  }
  try {
    return await scan(thread.path, thread.id, turnIds, callId, options);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!thread.path.endsWith(".zst"))
      return scan(
        thread.path + ".zst",
        thread.id,
        turnIds,
        callId,
        options,
      ).catch((error) => {
        if (error.code !== "ENOENT" || options.usage) throw error;
        return new Map();
      });
    if (options.usage) throw error;
    return new Map();
  }
}

export async function readRolloutContext(thread, turnId) {
  const trace = await readRolloutTrace(thread, new Set([turnId]), () => false);
  return trace.get(turnId)?.context;
}
