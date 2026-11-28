import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const secretaryHistoryVersion = 1;
export const secretaryUpgradeRequired =
  "此旧版秘书对话需要先转换为干净秘书续接，或恢复普通模式。";

export function codexSecretaryHistoryPath(directory, threadId) {
  return join(
    directory,
    createHash("sha256").update(threadId).digest("hex") + ".json",
  );
}

export async function codexSecretaryStatus(modes, path, runtimeId, threadId) {
  const compact = threadId.replace(/^urn:uuid:|[-{}]/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(compact))
    threadId = compact.replace(
      /^(........)(....)(....)(....)(............)$/,
      "$1-$2-$3-$4-$5",
    );
  const key = JSON.stringify([runtimeId, threadId]);
  if (modes[key] !== true) return "ordinary";
  if (modes.secretaryHistory?.[key] === secretaryHistoryVersion)
    return "secretary";
  try {
    await access(
      codexSecretaryHistoryPath(
        join(dirname(path), "..", "codex-secretary-history", runtimeId),
        threadId,
      ),
    );
    return "secretary";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "upgrade";
  }
}
