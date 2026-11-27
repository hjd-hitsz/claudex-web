// ACP 缺口：agy 1.5.18 的 session/rename、session/set_title、session/archive、
// session/unarchive 和 session/delete 返回 -32601 Method not found。
// 探测证据：隔离会话的摘要索引与 CLI F4 删除使用 SQLite v3，摘要缓存为
// jetbox protobuf 和 CLI JSON。标题由 annotations/<id>.pbtxt 加载。
// 切换条件：ACP 支持同一会话的标题、归档及永久删除后移除本模块，
// 见 docs/future_plan.md「改名、归档、删除同步到原生历史」。
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";

const columns = [
  "conversation_id",
  "title",
  "preview",
  "step_count",
  "last_modified_time",
  "workspace_uris",
  "status",
  "source",
  "project_id",
  "agent_name",
  "parent_conversation_id",
  "nesting_depth",
  "battle_id",
  "winning_conversation_id",
  "not_fully_idle",
  "killed",
  "last_user_input_time",
  "last_user_input_step_index",
  "app_data_dir",
  "raw_summary",
  "group_id",
];
const unknown = () => new Error("agy 原生历史存储格式与已验证版本不匹配");
const get = (db, query, ...args) => db.prepare(query).get(...args);

export function nativePath(directory, path, kind = "file") {
  // Validate each component before opening SQLite files or renaming sidecars.
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw unknown();
  const leaf = parts.pop();
  for (const part of parts) {
    directory = join(directory, part);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return;
    if (!entry.isDirectory()) throw unknown();
  }
  const file = join(directory, leaf);
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return;
  if (
    kind === "file"
      ? !entry.isFile() || entry.nlink !== 1
      : !entry.isDirectory()
  )
    throw unknown();
  return file;
}

export function openHistoryIndex(directory) {
  const path = nativePath(directory, "conversation_summaries.db");
  if (!path) throw unknown();
  for (const suffix of ["-wal", "-shm", "-journal"])
    nativePath(directory, "conversation_summaries.db" + suffix);
  const db = new DatabaseSync(path);
  try {
    const info = db.prepare("PRAGMA table_info(conversation_summaries)").all();
    if (
      get(db, "PRAGMA user_version").user_version !== 3 ||
      get(db, "PRAGMA journal_mode").journal_mode !== "wal" ||
      info.map(({ name }) => name).join() !== columns.join() ||
      info
        .filter(({ pk }) => pk)
        .map(({ name }) => name)
        .join() !== "conversation_id" ||
      get(
        db,
        "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'conversation_summaries'",
      )
    )
      throw unknown();
    db.exec("PRAGMA busy_timeout = 1500");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function verifyNativeConversation(directory, path, nativeId) {
  const file = nativePath(directory, path);
  if (!file) throw new Error("找不到 agy 原生会话数据库");
  for (const suffix of ["-wal", "-shm", "-journal"])
    nativePath(directory, path + suffix);
  const db = new DatabaseSync(file);
  try {
    // Exclusive locking also checks for a client that has the WAL open.
    // SQLite checkpoints and closes any idle WAL before the file is moved.
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    if (
      get(db, "PRAGMA user_version").user_version !== 1 ||
      get(db, "PRAGMA journal_mode").journal_mode !== "wal" ||
      !get(db, "SELECT 1 FROM trajectory_meta WHERE cascade_id = ?", nativeId)
    )
      throw unknown();
    db.exec("ROLLBACK");
  } catch (error) {
    if (error.errcode === 5 || error.errcode === 6)
      throw new Error("agy 原生会话数据库仍在使用，请关闭对应原生会话后重试", {
        cause: error,
      });
    throw error;
  } finally {
    db.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (nativePath(directory, path + suffix))
      throw new Error("agy 原生会话数据库仍在使用，请关闭对应原生会话后重试");
}

export function conversationSummary(db, nativeId) {
  const row = get(
    db,
    "SELECT * FROM conversation_summaries WHERE conversation_id = ?",
    nativeId,
  );
  if (
    row &&
    (row.app_data_dir !== "antigravity-cli" ||
      row.not_fully_idle ||
      !["", "CASCADE_RUN_STATUS_IDLE"].includes(row.status))
  )
    throw new Error("agy 原生索引显示该会话仍在运行或归属其他运行时");
  if (
    get(
      db,
      "SELECT 1 FROM conversation_summaries WHERE parent_conversation_id = ? AND (not_fully_idle OR status NOT IN ('', 'CASCADE_RUN_STATUS_IDLE')) LIMIT 1",
      nativeId,
    )
  )
    throw new Error("请先等待该 agy 会话的原生子任务结束");
  return row;
}

export function restoreConversationSummary(db, row) {
  db.prepare(
    "INSERT INTO conversation_summaries VALUES (" +
      columns.map(() => "?").join(",") +
      ") ON CONFLICT(conversation_id) DO NOTHING",
  ).run(...columns.map((name) => row[name]));
}

function fields(buffer) {
  const result = [];
  let offset = 0;
  function varint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < buffer.length; shift += 7n) {
      const byte = buffer[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw unknown();
  }
  while (offset < buffer.length) {
    const start = offset;
    const tag = varint();
    const type = Number(tag & 7n);
    const number = Number(tag >> 3n);
    if (!number || number > 0x1fffffff) throw unknown();
    let data;
    if (type === 2) {
      const length = Number(varint());
      data = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (type === 0) varint();
    else if (type === 1) offset += 8;
    else if (type === 5) offset += 4;
    else throw unknown();
    if (offset > buffer.length) throw unknown();
    result.push({ number, data, raw: buffer.subarray(start, offset) });
  }
  return result;
}

export function withoutJetboxSummary(buffer, id) {
  return Buffer.concat(
    fields(buffer)
      .filter((field) => {
        if (field.number !== 1) return true;
        if (!field.data) throw unknown();
        const entries = fields(field.data).filter(({ number }) => number === 1);
        if (entries.length !== 1 || !entries[0].data) throw unknown();
        return entries[0].data.toString() !== id;
      })
      .map(({ raw }) => raw),
  );
}

export function withoutCliSummary(buffer, path, id) {
  const value = JSON.parse(buffer.toString());
  const records =
    path === "cache/conversation_metadata.json" ? value?.conversations : value;
  if (!records || typeof records !== "object" || Array.isArray(records))
    throw unknown();
  let changed = false;
  if (records === value) {
    for (const [key, conversationId] of Object.entries(records)) {
      if (conversationId !== id) continue;
      delete records[key];
      changed = true;
    }
  } else if (Object.hasOwn(records, id)) {
    delete records[id];
    changed = true;
  }
  return changed ? Buffer.from(JSON.stringify(value, null, 2) + "\n") : buffer;
}

export function annotationTitle(before, title) {
  // Go's protobuf text encoder uses quoted strings with escapes. Match whole
  // tokens so a tag or an existing title containing "title:" stays intact.
  const source = before.toString();
  const token =
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|#[^\n]*|[{}<>\[\]]|[a-zA-Z_]\w*/g;
  let depth = 0;
  let range;
  for (const match of source.matchAll(token)) {
    if ("{[<".includes(match[0])) depth++;
    else if ("}]>".includes(match[0])) depth--;
    else if (depth === 0 && match[0] === "title") {
      const value =
        /^\s*:\s*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/.exec(
          source.slice(match.index + 5),
        );
      if (!value || range) throw unknown();
      const end = match.index + 5 + value[0].length;
      if (/^\s*["']/.test(source.slice(end))) throw unknown();
      range = [match.index, end];
    }
    if (depth < 0) throw unknown();
  }
  if (depth) throw unknown();
  // Keep UTF-8 characters literal. Protobuf text interprets JSON's surrogate
  // escapes differently, and expects \xNN escapes for ASCII control bytes.
  const quoted = JSON.stringify(title).replace(
    /\\\\|\\u00([0-9a-f]{2})/g,
    (escaped, byte) => (byte ? "\\x" + byte : escaped),
  );
  const field = "title:" + quoted;
  return Buffer.from(
    range
      ? source.slice(0, range[0]) + field + source.slice(range[1])
      : field + "\n" + source,
  );
}
