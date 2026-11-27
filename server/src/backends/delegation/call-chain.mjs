import { execScript } from "./exec-script.mjs";
import { traceId } from "./trace-ids.mjs";
import { traceItems, traceOrder } from "./turn-trace.mjs";
import { contextMetrics } from "../../../../shared/delegation-context.mjs";

const toolTypes = {
  commandExecution: "shell",
  fileChange: "apply_patch",
  mcpToolCall: "mcp",
  dynamicToolCall: "tool",
  collabAgentToolCall: "agent",
  webSearch: "web_search",
  imageView: "view_image",
  imageGeneration: "image_generation",
};

function decode(input) {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return input;
    }
  }
  return input;
}

function callArguments(payload) {
  return decode(payload?.arguments ?? payload?.input ?? payload?.action);
}

function commandLine(command) {
  if (typeof command === "string") return command.trim() && command;
  if (Array.isArray(command) && command.every((arg) => typeof arg === "string"))
    return command
      .map((arg) =>
        /^[\w@%+=:,./-]+$/.test(arg)
          ? arg
          : "'" + arg.replaceAll("'", "'\\''") + "'",
      )
      .join(" ");
}

function describe(item, payload, tool) {
  const args = callArguments(payload) ?? callArguments(item);
  const path =
    args?.file_path ?? args?.notebook_path ?? args?.path ?? item?.path;
  const location = typeof path === "string" ? { path } : {};
  const command = [
    item?.command,
    args?.cmd,
    args?.command,
    args?.argv,
    args?.action?.cmd,
    args?.action?.command,
    payload?.cmd,
    payload?.command,
  ]
    .map(commandLine)
    .find(Boolean);
  if (command) return { action: command, ...location };
  if (typeof args === "string" && args.trim()) {
    if (tool === "exec") return execScript(args);
    if (["exec_command", "Bash", "shell", "local_shell_call"].includes(tool))
      return { action: args };
  }
  const action = [
    args?.description,
    args?.title,
    args?.query,
    item?.query,
    args?.pattern,
  ].find(
    (value) => typeof value === "string" && value.length <= 240 && value.length,
  );
  return {
    ...(action && { action }),
    ...location,
  };
}

export function turnCalls(turn, trace, target) {
  const native = new Map();
  const changes = new Map();
  for (const item of traceItems(turn, trace).values()) {
    if (!item.id || !Object.hasOwn(toolTypes, item.type)) continue;
    // Claude's file hooks record the changes caused by a tool invocation.
    if (target === "claude" && item.type === "fileChange") {
      changes.set(item.id, item.changes?.length);
      continue;
    }
    native.set(item.id, item);
  }
  const calls = new Map();
  for (const [callId, item] of native) {
    const fileCount = item.changes?.length ?? changes.get("file-" + callId);
    const tool =
      target === "claude" && item.type === "commandExecution"
        ? "Bash"
        : item.tool || toolTypes[item.type];
    calls.set(callId, {
      callId,
      tool: [item.server, tool].filter(Boolean).join("."),
      ...(item.status && { status: item.status }),
      ...(fileCount && { fileCount }),
      ...describe(item, undefined, tool),
    });
  }
  for (const raw of trace?.calls.values() ?? []) {
    const { callId } = raw;
    const item = native.get(callId);
    const payload = raw.input.payload;
    const tool = payload.name ?? item?.tool ?? payload.type;
    const status = item?.status ?? (raw.returned ? "returned" : undefined);
    calls.set(callId, {
      callId,
      tool: (payload.namespace ? payload.namespace + "." : "") + tool,
      ...(status && { status }),
      ...(item?.changes?.length && { fileCount: item.changes.length }),
      ...describe(item, payload, tool),
    });
  }
  return traceOrder(calls, trace);
}

export function traceCall({
  callId,
  tool,
  status,
  fileCount,
  action,
  path,
  script,
}) {
  return {
    callId: traceId(callId),
    tool,
    ...(status && { status }),
    ...(fileCount && { fileCount }),
    ...(action && { action }),
    ...(path !== undefined && { path }),
    ...(script && { script }),
  };
}

function withoutFileTree(answer) {
  if (!answer) return answer;
  return answer.replace(
    /^(?:[^\n]*文件[^\n]*如下[。:：]\n\n)?```([^\n]*)\n([\s\S]*?)\n^```[ \t]*(?:\n\n|$)/gm,
    (block, language, tree) => {
      const [root, ...entries] = tree.split("\n");
      return ["", "text"].includes(language.trim()) &&
        root.endsWith("/") &&
        entries.length > 1 &&
        entries.every((line) => /^[ │]*(?:├──|└──) \S/.test(line))
        ? ""
        : block;
    },
  );
}

export function resultNoticePayload(result) {
  const { stepId, status, callChain, turns, artifacts, answer, error } = result;
  const context = contextMetrics(result.context);
  return {
    stepId: traceId(stepId),
    status,
    ...(context && { context }),
    callChain: callChain?.map(traceCall),
    turns: turns?.map(({ turnId, status, triggers, callCount }) => ({
      turnId,
      status,
      triggers,
      callCount:
        callCount ?? callChain?.filter((call) => call.turnId === turnId).length,
    })),
    ...(Array.isArray(artifacts) &&
      artifacts.length > 0 && {
        artifacts: artifacts.map(({ path, kind }) => ({ path, kind })),
      }),
    answer: withoutFileTree(answer),
    error,
  };
}

export function noticeResult(notice, task) {
  const stepId = notice.stepId ?? notice.id.slice(0, -":result".length);
  const result = task.steps?.find(({ id }) => id === stepId)?.result;
  return resultNoticePayload({ ...notice.payload, ...result, stepId });
}
