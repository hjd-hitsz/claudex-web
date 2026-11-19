export const CONTEXT_WINDOW_K = 1024;

export function contextWindowTokens(value, unit) {
  const input = String(value ?? "").trim();
  if (!input) return undefined;
  const inK = unit === "k";
  const format = inK ? /^\d+(?:\.\d+)?$/ : /^\d+$/;
  if (!format.test(input)) return null;
  const tokens = Number(input) * (inK ? CONTEXT_WINDOW_K : 1);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}
