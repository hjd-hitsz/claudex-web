export function formatTokenCount(tokens) {
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 100) / 10}K`;
}
