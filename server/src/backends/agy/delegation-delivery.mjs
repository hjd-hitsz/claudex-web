import { readPromptSections } from "../../prompts.mjs";
import { randomUUID } from "node:crypto";
import { noticeResult } from "../delegation/call-chain.mjs";
import { traceId } from "../delegation/trace-ids.mjs";

const secretaryResult = readPromptSections("delegation/workflow.md")(
  "secretaryResult",
);

export const noticeMarker = (id, legacy = false) =>
  `[Claudex delegation notice: ${legacy ? id : traceId(id)}]`;

export function delegationNotice(notice, task) {
  const backend = task.target === "codex" ? "Codex" : "Claude Code";
  const title = backend + " · 委派执行结果";
  const taskId = traceId(task.id);
  const result = noticeResult(notice, task);
  const body = JSON.stringify({
    taskId,
    ...result,
  });
  return {
    id: randomUUID(),
    noticeId: notice.id,
    items: [
      {
        id: notice.id,
        type: "delegationResult",
        taskId,
        stepId: result.stepId,
        target: task.target,
        status: result.status,
        ...(result.context && { context: result.context }),
      },
    ],
    prompt: [
      {
        type: "text",
        text: [noticeMarker(notice.id), title, secretaryResult, body].join(
          "\n",
        ),
      },
    ],
  };
}
