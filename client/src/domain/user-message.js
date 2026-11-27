import { referencePrompt } from "./prompt-text.js";
import {
  textReferences,
  isThreadReferenceInstruction,
} from "./inline-references.js";
import { planApprovalLabel } from "./plans.js";
import { parseAnnotations } from "./annotations.js";
import {
  codeLineAttachment,
  codeLineKey,
  readCodeLineAttachment,
} from "./code-line-reference.js";

export function fileReferenceInput(file) {
  return {
    type: "text",
    text: `引用本机${file.directory ? "目录" : "文件"}：${file.path}\n${referencePrompt("readFile")}`,
    text_elements: [],
  };
}

// 只识别完整的引用封装，普通正文中的路径和协议示例保持原样。
export function parseUserMessage(content = []) {
  const texts = [],
    annotations = [],
    references = [],
    codeAttachments = new Map(),
    attachments = [];
  const inline = content
    .filter((part) => part.type === "text")
    .flatMap((part) => textReferences(part.text || ""));
  for (const [index, part] of content.entries()) {
    const codeAttachment = readCodeLineAttachment(part, index);
    if (codeAttachment) {
      const key = codeLineKey(codeAttachment);
      const prior = codeAttachments.get(key);
      codeAttachments.set(
        key,
        prior
          ? codeLineAttachment(prior.code, prior.matches, prior.id, [
              ...new Set([...prior.anchors, ...codeAttachment.anchors]),
            ])
          : codeAttachment,
      );
      continue;
    }
    if (part.type !== "text") {
      attachments.push(part);
      continue;
    }
    if (
      inline.some((ref) => ref.kind === "thread") &&
      isThreadReferenceInstruction(part.text, inline)
    )
      continue;
    const snapshot =
      /^引用会话：([^\n]+)\n会话 ID：([^\n]+)\n以下为(?:选择引用|提交)时的已保存对话正文：\n/.exec(
        part.text || "",
      );
    if (
      snapshot &&
      inline.some(
        (ref) =>
          ref.kind === "thread" &&
          ref.threadId === snapshot[2] &&
          (ref.name === snapshot[1] ||
            JSON.stringify(ref.name) === snapshot[1]),
      )
    )
      continue;
    const parsed = parseAnnotations(part.text);
    annotations.push(...parsed.annotations);
    let text = parsed.text || "";
    const command = /^\/([^\s]+) /.exec(text);
    if (
      command &&
      inline.some(
        (ref) => ref.kind === "skill" && ref.native && ref.name === command[1],
      )
    )
      text = text.slice(command[0].length);
    const desktop =
      /^\s*# Files mentioned by the user:\r?\n([\s\S]*?)\r?\n## My request(?: for Codex)?:\r?\n/.exec(
        text,
      );
    if (desktop) {
      const lines = desktop[1].split(/\r?\n/).filter((line) => line.trim());
      const files = lines.map((line) => /^## (.+): (\/[^\r\n]+)$/.exec(line));
      if (files.length && files.every(Boolean)) {
        references.push(
          ...files.map(([, name, path]) => ({
            name,
            path,
            directory: path.endsWith("/"),
          })),
        );
        text = text.slice(desktop[0].length);
      }
    }
    const filePattern = /(?:^|\r?\n)引用本机(目录|文件)：([^\r\n]+)(?=\r?\n)/g;
    const files = [];
    for (const reference of [...text.matchAll(filePattern)].reverse()) {
      const tail = text
        .slice(reference.index + reference[0].length)
        .replace(/^\r?\n/, "")
        .trimEnd();
      if (
        tail !== referencePrompt("readFile") &&
        tail !== referencePrompt("legacyReadFile")
      )
        continue;
      const path = reference[2];
      files.unshift({
        name: path.replace(/\/$/, "").split("/").at(-1),
        path,
        directory: reference[1] === "目录",
      });
      text = text.slice(0, reference.index);
    }
    references.push(...files);
    if (text.trim()) texts.push(text.trimEnd());
  }
  return {
    text: texts.join("\n"),
    annotations,
    references,
    ...(codeAttachments.size && {
      codeAttachments: [...codeAttachments.values()],
    }),
    attachments,
  };
}

export function userMessageText(content, quote) {
  const {
    text,
    annotations,
    references,
    codeAttachments = [],
    attachments,
  } = parseUserMessage(content);
  return [
    planApprovalLabel(text),
    ...annotations.map((entry, index) => {
      const label = `注释 ${index + 1}`;
      if (!quote) return `${label}：${entry.annotation || entry.text}`;
      const description = entry.annotation
        ? `${label}：${entry.annotation}`
        : label;
      const excerpt = quote(entry)
        .split(/\r?\n/)
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
      return `${description}\n\n${excerpt}`;
    }),
    ...references
      .filter((file) => !text.includes("@" + file.name))
      .map((file) => "@" + file.name),
    ...attachments
      .filter(({ type }) => type === "file")
      .map(({ name }) => "@" + name),
    ...codeAttachments.map(({ matches }) =>
      matches.map(({ path, line }) => `${path}:${line}`).join("\n"),
    ),
  ]
    .filter(Boolean)
    .join(quote && annotations.length ? "\n\n" : "\n");
}
