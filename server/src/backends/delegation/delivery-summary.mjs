import {
  delegationPreview,
  delegationSnippet,
  deliverySnippet,
} from "../../../../shared/delivery-summary.mjs";
import { traceId } from "./trace-ids.mjs";

export function deliveryAnswer({ deliveryAnswer, conclusion, answer }) {
  if (deliveryAnswer !== undefined) return deliveryAnswer;
  if (conclusion?.trim()) return conclusion;
  if (answer?.trim()) return answer;
  return null;
}

export function delegationSummaries(steps) {
  return Object.fromEntries(
    steps
      .filter(({ result }) => result)
      .map(({ id, taskSummary, request, result }) => {
        const topic = request
          ?.split("\n")
          .find((line) => line.trim())
          ?.replace(/^(?:只读)?(?:调查|研究|实现|工程)?任务[：:]\s*/, "")
          .replace(/[（(]\/[^）)]+[）)]/g, "")
          .split(/[。！？]/, 1)[0];
        return [
          traceId(id),
          {
            title: deliverySnippet(taskSummary || topic || ""),
            preview:
              result.deliveryPreview ??
              (result.conclusion?.trim()
                ? delegationSnippet(result.conclusion)
                : delegationPreview(deliveryAnswer(result))),
          },
        ];
      }),
  );
}
