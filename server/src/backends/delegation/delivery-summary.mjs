import {
  delegationPreview,
  delegationSnippet,
  deliverySnippet,
} from "../../../../shared/delivery-summary.mjs";
import { traceId } from "./trace-ids.mjs";

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
              result.conclusion === undefined
                ? delegationPreview(result.answer)
                : delegationSnippet(result.conclusion),
          },
        ];
      }),
  );
}
