// ACP 缺口：agy 1.5.18 的 session/rename、session/set_title、session/archive、
// session/unarchive 和 session/delete 返回 -32601 Method not found。
// 探测证据：CLI 以 flock 独占 presence/<id>.lock，SQLite 使用 WAL。
// 切换条件：验证 ACP 元数据写入、恢复、删除及故障处理后移除此事务，
// 见 docs/future_plan.md「改名、归档、删除同步到原生历史」。
import { execFileSync } from "node:child_process";
import { constants, renameSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { writePrivateFile } from "../../../private-file.mjs";
import {
  conversationSummary,
  nativePath,
  openHistoryIndex,
  restoreConversationSummary,
  verifyNativeConversation,
} from "./native-history-index.mjs";

export const nativeHistoryRoot = ".claudex-history";
export const nativeHistoryId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function lockNativeHistory(directory, id) {
  if (!nativeHistoryId.test(id)) throw new Error("无效的 agy 原生会话标识");
  await mkdir(join(directory, "presence"), { recursive: true, mode: 0o700 });
  nativePath(directory, "presence", "directory");
  const file = "presence/" + id + ".lock";
  nativePath(directory, file);
  const handle = await open(
    join(directory, file),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // flock applies to the inherited open file description, held by this
    // worker until handle.close(). Keep the inode for future native opens.
    execFileSync("flock", ["-xn", "3"], {
      timeout: 2000,
      stdio: ["ignore", "ignore", "pipe", handle.fd],
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw new Error(
      error.status === 1
        ? "请关闭该 agy 原生会话后重试"
        : "无法取得 agy 原生会话文件锁",
      { cause: error },
    );
  }
}

const journalRoot = nativeHistoryRoot + "/transactions";
const journalError = () => new Error("agy 历史恢复日志与原生文件状态不一致");

async function clearBackup(backup) {
  await rm(join(backup, "journal.json"), { force: true });
  await rm(backup, { recursive: true, force: true });
}

async function restoreFiles(directory, backup, { files, moves }) {
  for (const { path, existed, key } of files.toReversed()) {
    const file = join(directory, path);
    const current = nativePath(directory, path) && (await readFile(file));
    const before = existed
      ? await readFile(join(backup, key + ".before"))
      : undefined;
    const after = await readFile(join(backup, key + ".after"));
    if (current ? before?.equals(current) : !existed) continue;
    if (!current?.equals(after)) throw journalError();
    if (existed) await writePrivateFile(file, before);
    else await rm(file);
  }
  for (const { from, to, kind } of moves.toReversed()) {
    const original = at(directory, backup, from, kind);
    const moved = at(directory, backup, to, kind);
    if (original && !moved) continue;
    if (original || !moved) throw journalError();
    await rename(moved, location(directory, backup, from));
  }
}

function location(directory, backup, path) {
  return path.startsWith("backup/")
    ? join(backup, path.slice(7))
    : join(directory, path);
}

function at(directory, backup, path, kind) {
  return path.startsWith("backup/")
    ? nativePath(backup, path.slice(7), kind)
    : nativePath(directory, path, kind);
}

function eraseSummary(db, id) {
  db.exec("PRAGMA secure_delete = ON");
  db.prepare(
    "DELETE FROM conversation_summaries WHERE conversation_id = ?",
  ).run(id);
}

export async function transactNativeHistory(directory, session, plan, save) {
  await mkdir(join(directory, journalRoot), { recursive: true, mode: 0o700 });
  nativePath(directory, journalRoot, "directory");
  const backup = await mkdtemp(join(directory, journalRoot, "edit-"));
  const journal = {
    key: randomUUID(),
    id: session.id,
    nativeId: session.nativeId,
    summary: Boolean(plan.deleteSummary),
    files: [],
    moves: plan.moves,
  };
  let db;
  let prepared = false;
  let written = false;
  const applied = { files: [], moves: [] };
  try {
    if (journal.summary) {
      db = openHistoryIndex(directory);
      db.exec("BEGIN IMMEDIATE");
      const row = conversationSummary(db, session.nativeId);
      if (row) await writePrivateFile(join(backup, "row"), serialize(row));
    }
    for (const [key, { path, before, after }] of plan.files.entries()) {
      if (before) await writePrivateFile(join(backup, key + ".before"), before);
      await writePrivateFile(join(backup, key + ".after"), after);
      journal.files.push({ path, existed: Boolean(before), key });
    }
    for (const { from, to, kind } of journal.moves)
      if (!at(directory, backup, from, kind) || at(directory, backup, to, kind))
        throw journalError();
    await writePrivateFile(
      join(backup, "journal.json"),
      JSON.stringify(journal),
    );
    prepared = true;
    for (const move of journal.moves) {
      const { from, to, kind } = move;
      const source = at(directory, backup, from, kind);
      if (!source || at(directory, backup, to, kind)) throw journalError();
      const destination = location(directory, backup, to);
      if (from === plan.database) {
        verifyNativeConversation(directory, from, session.nativeId);
        renameSync(source, destination);
      } else await rename(source, destination);
      applied.moves.push(move);
    }
    for (const [index, { path, before, after }] of plan.files.entries()) {
      const target = join(directory, path);
      const current = nativePath(directory, path) && (await readFile(target));
      if (before ? !current?.equals(before) : current) throw journalError();
      await writePrivateFile(target, after);
      applied.files.push(journal.files[index]);
    }
    if (db) {
      eraseSummary(db, session.nativeId);
      db.exec("COMMIT");
    }
    await save(journal.key);
    written = true;
  } catch (error) {
    if (db?.isTransaction) db.exec("ROLLBACK");
    if (prepared) {
      try {
        await restoreFiles(directory, backup, applied);
        await restoreSummary(db, backup, journal);
        prepared = false;
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          "agy 历史更新失败，已保留恢复备份",
        );
      }
    }
    throw error;
  } finally {
    db?.close();
    if (written || !prepared) {
      await clearBackup(backup).catch((error) => {
        console.warn("agy 历史恢复目录等待清理", backup, error.code);
      });
    }
  }
}

async function restoreSummary(db, backup, journal) {
  if (journal.summary && nativePath(backup, "row"))
    restoreConversationSummary(
      db,
      deserialize(await readFile(join(backup, "row"))),
    );
}

export async function recoverNativeHistory(directory, sessions) {
  const root = nativePath(directory, journalRoot, "directory");
  if (!root) return;
  for (const name of await readdir(root)) {
    if (!/^edit-[a-zA-Z0-9]+$/.test(name)) continue;
    const backup = nativePath(root, name, "directory");
    if (!backup) continue;
    if (nativePath(backup, "journal.json")) {
      const journal = JSON.parse(
        await readFile(join(backup, "journal.json"), "utf8"),
      );
      const session = sessions[journal.id];
      if (!session) continue;
      if (session.nativeId !== journal.nativeId) throw journalError();
      const lock = await lockNativeHistory(directory, journal.nativeId);
      try {
        if (session.nativeHistoryOperation !== journal.key) {
          const db = journal.summary ? openHistoryIndex(directory) : undefined;
          try {
            db?.exec("BEGIN IMMEDIATE");
            await restoreFiles(directory, backup, journal);
            await restoreSummary(db, backup, journal);
            db?.exec("COMMIT");
          } finally {
            db?.close();
          }
        }
        await clearBackup(backup);
      } finally {
        await lock.close();
      }
    } else {
      await rm(backup, { recursive: true, force: true });
    }
  }
}
