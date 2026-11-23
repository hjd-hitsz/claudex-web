export const CODE_LINE_FILE_LIMIT = 3;
export const CODE_LINE_LENGTH_LIMIT = 2048;

export function isCodeLineSnippet(code) {
  if (
    typeof code !== "string" ||
    code.length > CODE_LINE_LENGTH_LIMIT ||
    /[\r\0]/.test(code)
  )
    return false;
  const lines = code.split("\n");
  return Boolean(lines[0].trim() && lines.at(-1).trim());
}
