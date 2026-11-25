import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function ensureConversationDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error("会话管理目录须由当前系统用户独占");
}

export async function openConversationStore(directory) {
  await ensureConversationDirectory(directory);
  const path = join(directory, "messages.sqlite");
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
  const db = new DatabaseSync(path, { timeout: 2000 });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_settings (
        name TEXT PRIMARY KEY,
        value BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        sender_runtime TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient_runtime TEXT NOT NULL,
        recipient TEXT NOT NULL,
        request TEXT NOT NULL,
        reply_to TEXT,
        record TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt TEXT NOT NULL,
        UNIQUE (sender_runtime, sender, request)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS conversation_inbox
        ON messages (recipient_runtime, recipient, sequence);
      CREATE INDEX IF NOT EXISTS conversation_replies
        ON messages (reply_to, sequence);
      CREATE INDEX IF NOT EXISTS conversation_pending
        ON messages (recipient_runtime, status, sequence)
        WHERE status IN ('accepted', 'queued', 'unknown');
    `);
    db.prepare(
      "INSERT OR IGNORE INTO conversation_settings VALUES ('gateway_key', ?)",
    ).run(randomBytes(32));
    db.prepare(
      "UPDATE messages SET status = 'unknown', receipt = ? WHERE status = 'dispatching'",
    ).run(JSON.stringify({ reason: "服务退出时投递结果待核对" }));
  } catch (error) {
    db.close();
    throw error;
  }

  const get = db.prepare("SELECT * FROM messages WHERE id = ?");
  const request = db.prepare(
    "SELECT * FROM messages WHERE sender_runtime = ? AND sender = ? AND request = ?",
  );
  const insert = db.prepare(`
    INSERT INTO messages (id, sender_runtime, sender, recipient_runtime, recipient, request, reply_to, record, status, receipt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', '{}')
    ON CONFLICT (sender_runtime, sender, request) DO NOTHING
  `);
  const update = db.prepare(
    "UPDATE messages SET status = ?, receipt = ? WHERE id = ?",
  );
  const claim = db.prepare(
    "UPDATE messages SET status = 'dispatching', receipt = '{}', record = ? WHERE id = ?",
  );
  const inbox = db.prepare(`
    SELECT * FROM messages WHERE recipient_runtime = ? AND recipient = ? AND sequence < ?
    ORDER BY sequence DESC LIMIT ?
  `);
  const replies = db.prepare(
    "SELECT * FROM messages WHERE reply_to = ? ORDER BY sequence",
  );
  const pending = db.prepare(`
    SELECT * FROM messages
    WHERE recipient_runtime = ? AND status IN ('accepted', 'queued', 'unknown')
    ORDER BY sequence
  `);
  function record(row) {
    if (!row) return null;
    const { from, to, body, acceptedAt } = JSON.parse(row.record);
    return {
      from: { ...from, runtimeId: row.sender_runtime, threadId: row.sender },
      to: { ...to, runtimeId: row.recipient_runtime, threadId: row.recipient },
      body,
      acceptedAt,
      id: row.id,
      requestId: row.request,
      replyTo: row.reply_to,
      status: row.status,
      receipt: JSON.parse(row.receipt),
      sequence: row.sequence,
    };
  }
  const snapshot = ({ title, cwd }) => ({ title, cwd });
  function messageData(from, to, body, acceptedAt) {
    return JSON.stringify({
      from: snapshot(from),
      to: snapshot(to),
      body,
      acceptedAt,
    });
  }
  return {
    gatewayKey: db
      .prepare(
        "SELECT value FROM conversation_settings WHERE name = 'gateway_key'",
      )
      .get().value,
    get: (id) => record(get.get(id)),
    existing(sender, requestId) {
      return record(request.get(sender.runtimeId, sender.threadId, requestId));
    },
    insert(requestId, replyTo, from, to, body) {
      const id = randomUUID();
      insert.run(
        id,
        from.runtimeId,
        from.threadId,
        to.runtimeId,
        to.threadId,
        requestId,
        replyTo,
        messageData(from, to, body, new Date().toISOString()),
      );
      return record(request.get(from.runtimeId, from.threadId, requestId));
    },
    claim({ id, from, to, body, acceptedAt }) {
      claim.run(messageData(from, to, body, acceptedAt), id);
    },
    update(id, status, receipt = {}) {
      update.run(status, JSON.stringify(receipt), id);
    },
    inbox: (recipient, cursor, limit) =>
      inbox
        .all(recipient.runtimeId, recipient.threadId, cursor, limit)
        .map(record),
    replies: (id) => replies.all(id).map(record),
    pending: (runtime) => pending.all(runtime).map(record),
    close: () => db.close(),
  };
}
