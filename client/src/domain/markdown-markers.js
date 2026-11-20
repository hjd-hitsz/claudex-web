const untouched = new Set([
  "code",
  "inlineCode",
  "math",
  "inlineMath",
  "html",
  "link",
  "linkReference",
  "image",
]);

// 标记仅替换可见正文，生成器按源码顺序提供互不重叠的范围。
export function replaceMarkdownMarkers(node, markers) {
  if (!node.children || untouched.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text") {
      replaceMarkdownMarkers(child, markers);
      return [child];
    }
    const parts = [];
    let offset = 0;
    for (const { start, end, replacement } of markers(child.value)) {
      if (start > offset)
        parts.push({ type: "text", value: child.value.slice(offset, start) });
      parts.push(replacement);
      offset = end;
    }
    if (!offset) return [child];
    if (offset < child.value.length)
      parts.push({ type: "text", value: child.value.slice(offset) });
    return parts;
  });
}
