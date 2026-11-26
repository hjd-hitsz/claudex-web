export const delegationLabels = {
  accepted: "已受理",
  starting: "正在启动",
  running: "运行中",
  waiting: "等待确认",
  completed: "执行已结束",
  failed: "执行失败",
  interrupted: "已停止",
  unknown: "待核对",
};

export function delegationTargets(state) {
  const agy = state.backends.find(({ id }) => id === "agy");
  return state.backends.filter(
    ({ id, enabled }) =>
      ["codex", "claude"].includes(id) &&
      enabled &&
      agy?.delegates?.[id]?.enabled,
  );
}

export function selectedDelegate(state) {
  const targets = delegationTargets(state);
  if (targets.some(({ id }) => id === state.agyDelegateTo))
    return state.agyDelegateTo;
  return targets.find(({ id }) => id === "codex")?.id ?? targets[0]?.id;
}
