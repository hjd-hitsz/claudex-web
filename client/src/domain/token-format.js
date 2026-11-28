export function formatTokenCount(tokens) {
  if (tokens >= 1000000) return `${Math.round(tokens / 100000) / 10}M`;
  if (tokens < 1000) return String(tokens);
  const thousands = Math.round(tokens / 100) / 10;
  return thousands === 1000 ? "1M" : `${thousands}K`;
}
