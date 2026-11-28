export const guardedSecretaryOperations = new Set([
  "thread/resume",
  "thread/fork",
  "thread/revert",
  "thread/rollback",
  "thread/compact/start",
  "thread/goal/set",
  "thread/queue/add",
  "thread/queue/update",
  "thread/queue/start",
  "thread/inject_items",
  "review/start",
  "turn/start",
  "turn/steer",
]);

export const secretaryUpgradeRequired =
  "此旧版秘书对话需要先转换为干净秘书续接，或恢复普通模式。";
