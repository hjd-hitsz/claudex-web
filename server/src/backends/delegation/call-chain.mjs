import { artifactTree } from "./artifact-tree.mjs";

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

function callArguments(payload) {
  if (typeof payload?.arguments === "string") {
    try {
      return JSON.parse(payload.arguments);
    } catch {
      return payload.arguments;
    }
  }
  return payload?.arguments ?? payload?.input ?? payload?.action;
}

function describe(item, input) {
  const args = input ?? item?.arguments;
  const path =
    args?.file_path ?? args?.notebook_path ?? args?.path ?? item?.path;
  const action = [
    args?.description,
    args?.title,
    args?.cmd,
    args?.command,
    item?.command,
    args?.query,
    item?.query,
    args?.pattern,
  ].find(
    (value) => typeof value === "string" && value.length <= 240 && value.length,
  );
  return {
    ...(action && { action }),
    ...(typeof path === "string" && { path }),
  };
}

export function turnCalls(turn, rawCalls = new Map(), target) {
  const native = new Map();
  const changes = new Map();
  for (const item of turn.items || []) {
    if (!item.id || !Object.hasOwn(toolTypes, item.type)) continue;
    // Claude's file hooks record the changes caused by a tool invocation.
    if (target === "claude" && item.type === "fileChange") {
      changes.set(item.id, item.changes?.length);
      continue;
    }
    native.set(item.id, item);
  }
  const calls = [];
  for (const raw of rawCalls.values()) {
    const { callId } = raw;
    const item = native.get(callId);
    const payload = raw.input.payload;
    const tool = payload.name ?? item?.tool ?? payload.type;
    const status = item?.status ?? (raw.returned ? "returned" : undefined);
    calls.push({
      callId,
      turnId: turn.id,
      tool: (payload.namespace ? payload.namespace + "." : "") + tool,
      source: "rollout",
      ...(status && { status }),
      ...(item?.changes?.length && { fileCount: item.changes.length }),
      ...describe(item, callArguments(payload)),
    });
    native.delete(callId);
  }
  for (const [callId, item] of native) {
    const fileCount = item.changes?.length ?? changes.get("file-" + callId);
    const tool =
      target === "claude" && item.type === "commandExecution"
        ? "Bash"
        : item.tool || toolTypes[item.type];
    calls.push({
      callId,
      turnId: turn.id,
      tool: [item.server, tool].filter(Boolean).join("."),
      source: "history",
      ...(item.status && { status: item.status }),
      ...(fileCount && { fileCount }),
      ...describe(item),
    });
  }
  return calls;
}

export function resultNoticePayload(result) {
  const {
    stepId,
    status,
    callChain,
    turns,
    artifacts,
    fileTree = Array.isArray(artifacts) ? artifactTree(artifacts) : undefined,
    answer,
    error,
  } = result;
  return { stepId, status, callChain, turns, fileTree, answer, error };
}

export function noticeResult(notice, task) {
  const stepId = notice.stepId ?? notice.id.slice(0, -":result".length);
  const result = task.steps?.find(({ id }) => id === stepId)?.result;
  return resultNoticePayload({ ...notice.payload, ...result, stepId });
}
