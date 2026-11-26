import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";

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

async function scan(path, threadId, turnIds, onlyCallId) {
  const source = createReadStream(path);
  const input = path.endsWith(".zst")
    ? source.pipe(createZstdDecompress())
    : source;
  if (source !== input) source.on("error", (error) => input.destroy(error));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const turns = new Map();
  let turnId;
  let identified = false;
  try {
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // An active rollout may end with a partially persisted line.
        continue;
      }
      const { type, payload } = record ?? {};
      if (!payload || typeof payload !== "object") continue;
      if (!identified) {
        if (type !== "session_meta" || payload.id !== threadId)
          return new Map();
        identified = true;
        continue;
      }
      if (
        type === "turn_context" ||
        (type === "event_msg" && payload.type === "task_started")
      )
        turnId = payload.turn_id;
      if (
        type === "event_msg" &&
        ["task_complete", "turn_aborted"].includes(payload.type)
      )
        turnId = undefined;
      const owner =
        payload.internal_chat_message_metadata_passthrough?.turn_id ?? turnId;
      if (
        type !== "response_item" ||
        !turnIds.has(owner) ||
        (!inputs.has(payload.type) && !outputs.has(payload.type))
      )
        continue;
      const callId =
        payload.call_id ?? (inputs.has(payload.type) && payload.id);
      if (!callId || (onlyCallId && onlyCallId !== callId)) continue;
      if (!turns.has(owner)) turns.set(owner, new Map());
      const calls = turns.get(owner);
      if (inputs.has(payload.type))
        calls.set(callId, {
          callId,
          input: record,
          ...(onlyCallId && { outputs: [] }),
        });
      else {
        const call = calls.get(callId);
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

export async function readRolloutTools(thread, turnIds, callId) {
  if (!thread.path) return new Map();
  try {
    return await scan(thread.path, thread.id, turnIds, callId);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!thread.path.endsWith(".zst"))
      return scan(thread.path + ".zst", thread.id, turnIds, callId).catch(
        (error) => {
          if (error.code !== "ENOENT") throw error;
          return new Map();
        },
      );
    return new Map();
  }
}
