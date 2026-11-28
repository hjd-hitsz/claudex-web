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

function matchesCall(filter, call, item, payload, fileChanges) {
  const { changes, cwd, command, tool, path, query } = item ?? {};
  return [
    call.tool,
    call.action,
    call.path,
    call.script,
    command,
    cwd,
    tool,
    path,
    query,
    JSON.stringify(callArguments(item)),
    JSON.stringify(callArguments(payload)),
    JSON.stringify(
      (changes ?? fileChanges)?.map(({ path, kind }) => ({ path, kind })),
    ),
  ].some(
    (value) =>
      typeof value === "string" && value.toLowerCase().includes(filter),
  );
}

export function turnCalls(turn, trace, target, filter) {
  const native = new Map();
  const changes = new Map();
  for (const item of traceItems(turn, trace).values()) {
    if (!item.id || !Object.hasOwn(toolTypes, item.type)) continue;
    // Claude's file hooks record the changes caused by a tool invocation.
    if (target === "claude" && item.type === "fileChange") {
      changes.set(item.id, item.changes);
      continue;
    }
    native.set(item.id, item);
  }
  const calls = new Map();
  for (const [callId, item] of native) {
    const fileCount =
      item.changes?.length ?? changes.get("file-" + callId)?.length;
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
  const ordered = traceOrder(calls, trace);
  return filter
    ? ordered.filter((call) =>
        matchesCall(
          filter,
          call,
          native.get(call.callId),
          trace?.calls.get(call.callId)?.input.payload,
          changes.get("file-" + call.callId),
        ),
      )
    : ordered;
}

function excerpt(text) {
  if (!text || text.length <= 160) return text;
  return text.slice(0, 159).replace(/[\uD800-\uDBFF]$/, "") + "…";
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
    callId,
    tool,
    ...(status && { status }),
    ...(fileCount && { fileCount }),
    ...((action || script) && { action: excerpt(action || script) }),
    ...(path !== undefined && { path: excerpt(path) }),
  };
}

export function resultNoticePayload(result) {
  const { stepId, status, conclusion, answer, error } = result;
  const context = contextMetrics(result.context);
  return {
    stepId: traceId(stepId),
    status,
    answer: conclusion ?? answer,
    ...(context && { context }),
    ...(error && { error }),
  };
}

export function noticeResult(notice, task) {
  const stepId = notice.stepId ?? notice.id.slice(0, -":result".length);
  const result = task.steps?.find(({ id }) => id === stepId)?.result;
  return resultNoticePayload({ ...notice.payload, ...result, stepId });
}
