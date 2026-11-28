export const delegationLabels = {
  accepted: "已受理",
  starting: "正在启动",
  running: "运行中",
  waiting: "等待确认",
  completed: "执行已结束",
  failed: "执行失败",
  interrupted: "已停止",
  stopped_by_user: "已停止",
  unknown: "待核对",
};

export function acceptsDelegation(state, backendId) {
  return (
    state.backends.find(({ id }) => id === "agy")?.delegates?.[backendId]
      ?.enabled === true
  );
}

export function delegationTargets(state) {
  return state.backends.filter(
    ({ id, enabled }) =>
      ["codex", "claude"].includes(id) &&
      enabled &&
      acceptsDelegation(state, id),
  );
}

export function selectedDelegate(state) {
  const targets = delegationTargets(state);
  if (targets.some(({ id }) => id === state.agyDelegateTo))
    return state.agyDelegateTo;
  return targets.find(({ id }) => id === "codex")?.id ?? targets[0]?.id;
}

export function nativeDelegationTarget(state) {
  if (!state.nativeDelegation || state.backendId === "agy") return null;
  const peer = state.backendId === "codex" ? "claude" : "codex";
  return state.backends.find(({ id }) => id === peer);
}

export function canUseNativeDelegation(state) {
  const target = nativeDelegationTarget(state);
  return Boolean(
    target?.enabled &&
    target.ready !== false &&
    acceptsDelegation(state, target.id),
  );
}
