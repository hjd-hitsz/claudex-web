const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const promptFields = {
  inputTokens: "inputTokens",
  cachedInputTokens: "cachedReadTokens",
  outputTokens: "outputTokens",
  reasoningOutputTokens: "thoughtTokens",
  totalTokens: "totalTokens",
};

export function agyTokenUsage(activity) {
  const { session, turn, usage, promptUsage, contextChanged } = activity;
  const manual = turn.compaction?.source === "manual";
  const compacted = turn.compaction?.status === "completed";
  const previous = contextChanged ? undefined : session.tokenUsage;
  const size = usage?.size ?? previous?.modelContextWindow;
  const last =
    manual && !compacted
      ? previous?.last
      : validCount(usage?.used)
        ? { totalTokens: usage.used }
        : undefined;
  // Context occupancy comes from the last notification. The prompt response
  // accounts for the entire round, including model calls around compaction.
  const round = Object.fromEntries(
    Object.entries(promptFields)
      .map(([field, source]) => [field, promptUsage?.[source]])
      .filter(([, value]) => validCount(value)),
  );
  return {
    turnId: turn.id,
    round,
    ...(validCount(size) && size > 0 && { modelContextWindow: size }),
    ...(last && { last }),
    ...(!last &&
      (compacted || previous?.awaitingMeasurement) && {
        awaitingMeasurement: true,
      }),
  };
}
