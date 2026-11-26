import { contextMetrics } from "../../../../shared/delegation-context.mjs";

export function delegationContext(thread, turnId, traceContext) {
  if (traceContext) return contextMetrics(traceContext);
  const turns = thread.turns ?? [];
  const end = turns.findIndex(({ id }) => id === turnId);
  if (end < 0) return;
  const compactCount = new Set(
    turns
      .slice(0, end + 1)
      .flatMap(({ items }) =>
        (items ?? [])
          .filter(({ type }) => type === "contextCompaction")
          .map(({ id }) => id ?? Symbol()),
      ),
  ).size;
  const usage = end === turns.length - 1 ? thread.tokenUsage : undefined;
  return contextMetrics({
    usedTokens: usage?.last?.totalTokens,
    totalTokens: usage?.modelContextWindow,
    compactCount,
  });
}
