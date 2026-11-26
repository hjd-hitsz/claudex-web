import { delegationStepToolName } from "../../conversation-manager/tools.mjs";

export function answerAcpPermission(entry, method, params) {
  if (params.sessionId !== entry.nativeId)
    throw new Error("agy 请求会话不匹配");
  if (method !== "session/request_permission")
    throw new Error("当前网页无法处理 agy 请求：" + method);
  const { options, toolCall } = params;
  const raw = toolCall.rawInput || {};
  const names = ["ask_codex", "ask_claude", delegationStepToolName];
  const delegation =
    names.some((name) => toolCall.name === "mcp_claudex_delegation_" + name) ||
    (raw.ServerName === "claudex_delegation" && names.includes(raw.ToolName));
  const permitted =
    delegation ||
    !["execute", "fetch", "delete", "move"].includes(toolCall.kind);
  const option = permitted && options.find(({ kind }) => kind === "allow_once");
  return {
    outcome: option
      ? { outcome: "selected", optionId: option.optionId }
      : { outcome: "cancelled" },
  };
}
