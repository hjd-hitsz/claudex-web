import { randomUUID } from "node:crypto";

export const noticeMarker = (id) => `[Claudex delegation notice: ${id}]`;

export function delegationNotice(notice, task) {
  const backend = task.target === "codex" ? "Codex" : "Claude Code";
  const title = backend + " · 委派执行结果";
  const body = JSON.stringify(notice.payload);
  return {
    id: randomUUID(),
    noticeId: notice.id,
    items: [
      {
        id: notice.id,
        type: "agentMessage",
        phase: "commentary",
        text: `**${title}**\n\n任务 ID：${task.id}。详情见子代理面板。`,
        origin: { kind: "system", source: "agy-delegation" },
      },
    ],
    prompt: [
      {
        type: "text",
        text: [
          noticeMarker(notice.id),
          title,
          "任务 ID：" + task.id,
          "以下是本次委派完成后的汇总。按用户的验收条件核对，缺项可携原任务 ID 追问，文档由你阅读文件后写入。",
          body,
        ].join("\n"),
      },
    ],
  };
}
