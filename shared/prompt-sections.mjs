/**
 * Returns a reader for the text beneath each marked Markdown heading.
 * Only headings ending with a prompt key delimit sections.
 * @param {string} markdown
 * @param {string} file
 */
export function promptSections(markdown, file) {
  const parts = markdown
    .replace(/\r\n/g, "\n")
    .split(/^## [^\n]+ <!-- prompt: (\w+) -->[ \t]*$/m);
  const sections = new Map();
  for (let index = 1; index < parts.length; index += 2) {
    const key = parts[index];
    const body = parts[index + 1].replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
    if (sections.has(key) || !body.trim())
      throw new Error(`提示词段落重复或为空：${file} #${key}`);
    sections.set(key, body);
  }
  return (name) => {
    const body = sections.get(name);
    if (body === undefined)
      throw new Error(`找不到提示词段落：${file} #${name}`);
    return body;
  };
}
