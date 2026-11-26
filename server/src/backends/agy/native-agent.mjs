import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const secretaryName = "claudex-secretary";

export async function savedAgyAgent(
  nativeId,
  directory = join(homedir(), ".gemini", "antigravity-cli"),
) {
  if (!nativeId) return;
  const path = join(directory, "conversation_summaries.db");
  try {
    await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = database
      .prepare("PRAGMA table_info(conversation_summaries)")
      .all();
    if (columns.some(({ name }) => name === "agent_name"))
      return database
        .prepare(
          "SELECT agent_name FROM conversation_summaries WHERE conversation_id = ?",
        )
        .get(nativeId)?.agent_name;
  } finally {
    database.close();
  }
}
