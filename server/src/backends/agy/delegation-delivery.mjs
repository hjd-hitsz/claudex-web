import { readPromptSections } from "../../prompts.mjs";
import { randomUUID } from "node:crypto";
import { noticeResult } from "../delegation/call-chain.mjs";

const secretaryResult = readPromptSections("delegation/workflow.md")(
  "secretaryResult",
);

export const noticeMarker = (id) => `[Claudex delegation notice: ${id}]`;

export function delegationNotice(notice, task) {
  const backend = task.target === "codex" ? "Codex" : "Claude Code";
  const title = backend + " · 委派执行结果";
  const body = JSON.stringify({
    taskId: task.id,
    ...noticeResult(notice, task),
  });
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
          secretaryResult,
          body,
        ].join("\n"),
      },
    ],
  };
}
