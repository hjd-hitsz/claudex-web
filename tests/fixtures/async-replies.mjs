// 保留 Codex 原生异步投递记录的字段结构，正文与标识使用隔离数据。
export const asyncReplies = [
  {
    type: "agentMessage",
    id: "async-first",
    text: "已记录补充要求，继续检查实现。",
    phase: "final_answer",
    memoryCitation: null,
    delivery: "async",
    questions: null,
    startedAtMs: 1794500716248,
    completedAtMs: 1794500716248,
  },
  {
    type: "agentMessage",
    id: "async-second",
    text: "项目指令已更新，继续执行验证。",
    phase: "final_answer",
    memoryCitation: null,
    delivery: "async",
    questions: null,
    startedAtMs: 1794500971985,
    completedAtMs: 1794500971985,
  },
];
