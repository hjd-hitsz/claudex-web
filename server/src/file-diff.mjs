export function textPatch(before, after) {
  const lines = (text, prefix) => {
    const rows = text.split("\n");
    if (rows.at(-1) === "") rows.pop();
    return (
      rows.map((line) => prefix + line + "\n").join("") +
      (text && !text.endsWith("\n") ? "\\ No newline at end of file\n" : "")
    );
  };
  const count = (text) =>
    text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
  return `--- a/file\n+++ b/file\n@@ -${before ? 1 : 0},${count(before)} +${after ? 1 : 0},${count(after)} @@\n${lines(before, "-")}${lines(after, "+")}`;
}
