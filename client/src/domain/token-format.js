export function formatTokenCount(tokens) {
  if (tokens >= 1000000) return `${Math.round(tokens / 100000) / 10}M`;
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 100) / 10}K`;
}
