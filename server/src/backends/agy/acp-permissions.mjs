export function answerAcpPermission(entry, method, params) {
  if (params.sessionId !== entry.nativeId)
    throw new Error("agy 请求会话不匹配");
  if (method !== "session/request_permission")
    throw new Error("当前网页无法处理 agy 请求：" + method);
  const option =
    params.options.find(({ kind }) => kind === "allow_once") ||
    params.options.find(({ kind }) => kind === "allow_always");
  return {
    outcome: option
      ? { outcome: "selected", optionId: option.optionId }
      : { outcome: "cancelled" },
  };
}
