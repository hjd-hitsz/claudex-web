import { replaceMarkdownMarkers } from "./markdown-markers.js";

export function remarkFileReferences({ references = [] } = {}) {
  const ordered = references
    .map((file, index) => ({ file, index }))
    .sort((a, b) => b.file.name.length - a.file.name.length);
  const referenceNode = (index) => ({
    type: "fileReference",
    data: { hName: "file-ref", hProperties: { index: String(index) } },
  });
  return (root) => {
    const used = new Set();
    replaceMarkdownMarkers(root, function* (value) {
      for (let position = 0; position < value.length; position++) {
        if (value[position] !== "@") continue;
        const match = ordered.find(({ file }) =>
          value.startsWith("@" + file.name, position),
        );
        if (!match) continue;
        const start = position;
        used.add(match.index);
        position += match.file.name.length;
        yield {
          start,
          end: position + 1,
          replacement: referenceNode(match.index),
        };
      }
    });
    const remaining = references.flatMap((_, index) =>
      used.has(index) ? [] : [referenceNode(index)],
    );
    if (remaining.length)
      root.children.push({
        type: "unusedFileReferences",
        data: { hName: "file-reference-list" },
        children: remaining,
      });
  };
}
