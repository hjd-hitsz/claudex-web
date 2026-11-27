export function delegationModeRequests(modes, enabled) {
  const supported = (backend) => enabled && backend.id !== "agy";

  function forward(backend, method, params) {
    const { delegationMode, ...forwarded } = params || {};
    const selectedMode =
      method === "thread/start" && supported(backend)
        ? delegationMode === true
        : undefined;
    if (selectedMode !== undefined) forwarded.delegationMode = selectedMode;
    return { forwarded, selectedMode };
  }

  async function set(entry, params, call) {
    const { backend } = entry;
    const { threadId, delegationMode } = params;
    if (!supported(backend) || !threadId || typeof delegationMode !== "boolean")
      throw new Error("委派模式需要有效对话和开关状态。");
    if (backend.id === "claude")
      await call(entry, "lan/delegation/mode/set", params);
    await modes.save(backend, threadId, delegationMode);
    return { delegationMode };
  }

  async function project(backend, method, result, selected) {
    if (!supported(backend) || !result?.thread?.id) return result;
    const creating = method === "thread/start" || method === "thread/fork";
    if (!creating && method !== "thread/resume" && method !== "thread/read")
      return result;
    const threadId = result.thread.id;
    const delegationMode =
      backend.id === "claude" && typeof result.delegationMode === "boolean"
        ? result.delegationMode
        : creating
          ? (result.thread.delegationMode ?? selected === true)
          : await modes.enabled(backend, threadId);
    if (creating) await modes.save(backend, threadId, delegationMode);
    return {
      ...result,
      delegationMode,
      thread: { ...result.thread, delegationMode },
    };
  }

  return { forward, set, project };
}
