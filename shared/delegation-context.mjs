export function contextMetrics(context) {
  const { usedTokens, totalTokens, compactCount } = context ?? {};
  const metrics = {
    ...(Number.isSafeInteger(usedTokens) && usedTokens >= 0 && { usedTokens }),
    ...(Number.isSafeInteger(totalTokens) &&
      totalTokens > 0 && { totalTokens }),
    ...(Number.isSafeInteger(compactCount) &&
      compactCount >= 0 && { compactCount }),
  };
  return Object.keys(metrics).length ? metrics : undefined;
}

export function usageContext(tokenUsage) {
  return contextMetrics({
    usedTokens: tokenUsage?.last?.totalTokens,
    totalTokens: tokenUsage?.modelContextWindow,
  });
}
