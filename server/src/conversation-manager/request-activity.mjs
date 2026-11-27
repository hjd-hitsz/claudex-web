const approvals = new Set([
  "lan/agy/permission",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export function requestActivity(method, params) {
  if (method === "item/tool/requestUserInput") return "waitingForInput";
  if (approvals.has(method)) return "waitingForApproval";
  if (method !== "mcpServer/elicitation/request") return;
  if (
    params?.mode === "openai/userVerification" ||
    params?._meta?.codex_approval_kind === "mcp_tool_call"
  )
    return "waitingForApproval";
  return "waitingForInput";
}
