import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { writePrivateFile } from "../../private-file.mjs";
import { isUserPrompt, visibleSessionMessages } from "./messages.mjs";
import { nativeTranscripts, readSessionTranscript } from "./native-records.mjs";

// Instruction attachments and request snapshots belong to their original
// execution. Rebuild the transcript chain from primary conversation records.
export async function projectSecretaryHistory(sourceId, { dir, internalIds }) {
  const options = { dir, includeSystemMessages: true };
  const [{ key }] = await nativeTranscripts("getSessionMessages", [
    sourceId,
    options,
  ]);
  if (
    !key.projectKey ||
    [".", ".."].includes(key.projectKey) ||
    basename(key.projectKey) !== key.projectKey
  )
    throw new Error("Claude 原生记录缺少有效的项目存储目录。");
  const history = visibleSessionMessages(
    await readSessionTranscript(sourceId, options),
    internalIds,
  ).filter(
    (message) =>
      !message.isSidechain &&
      !message.isMeta &&
      !message.is_meta &&
      !message.isSynthetic &&
      !message.isCompactSummary &&
      !message.isApiErrorMessage &&
      !message.isVisibleInTranscriptOnly &&
      !(message.type === "assistant" && message.error),
  );
  const blocks = (entry) =>
    typeof entry.message?.content === "string"
      ? [{ type: "text", text: entry.message.content }]
      : (entry.message?.content ?? []);
  const results = new Set(
    history
      .filter(({ type }) => type === "user")
      .flatMap(blocks)
      .filter(({ type }) => type === "tool_result")
      .map(({ tool_use_id }) => tool_use_id),
  );
  const sessionId = randomUUID();
  const copies = [];
  const calls = new Set();
  for (const entry of history) {
    const role = entry.message?.role;
    const userPrompt = isUserPrompt(entry);
    const content = blocks(entry).filter((block) => {
      if (entry.type === "assistant" && role === "assistant") {
        if (block.type === "tool_use" && results.has(block.id)) {
          calls.add(block.id);
          return true;
        }
        return block.type === "text";
      }
      if (entry.type !== "user" || role !== "user") return false;
      if (block.type === "tool_result") return calls.delete(block.tool_use_id);
      return (
        userPrompt &&
        ["text", "image", "document"].includes(block.type) &&
        !entry.isCompletedLocalCommand
      );
    });
    if (!content.length) continue;
    copies.push({
      type: entry.type,
      sessionId,
      uuid: randomUUID(),
      parentUuid: copies.at(-1)?.uuid ?? null,
      timestamp: entry.timestamp,
      cwd: entry.cwd || dir,
      isSidechain: false,
      ...(userPrompt && { promptSource: entry.promptSource ?? "user" }),
      message:
        role === "assistant"
          ? { ...entry.message, content }
          : { role, content },
    });
  }
  if (!copies.length) return { sessionId, initialized: false };
  await writePrivateFile(
    join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      "projects",
      key.projectKey,
      sessionId + ".jsonl",
    ),
    copies.map((entry) => JSON.stringify(entry) + "\n").join(""),
  );
  return { sessionId, initialized: true };
}
