import { isAbsolute, relative, resolve, sep } from "node:path";
import { textPatch } from "../../file-diff.mjs";

export function acpFileChanges(update, cwd) {
  if (update.status !== "completed") return [];
  return (update.content || []).flatMap(({ type, path, oldText, newText }) => {
    if (
      type !== "diff" ||
      typeof path !== "string" ||
      typeof newText !== "string" ||
      (oldText !== null && typeof oldText !== "string") ||
      oldText === newText
    )
      return [];
    const target = relative(cwd, resolve(cwd, path));
    if (
      !target ||
      target === ".." ||
      target.startsWith(".." + sep) ||
      isAbsolute(target)
    )
      return [];
    return [
      {
        path: target,
        kind: { type: oldText == null ? "add" : "update" },
        diff: oldText == null ? newText : textPatch(oldText, newText),
      },
    ];
  });
}
