import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateWebDirectory } from "./web-config-migration.mjs";

const period = 30;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const binding = (mode, key) =>
  mode + ":" + createHash("sha256").update(key).digest("hex");

function base32(bytes) {
  let result = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}

export async function prepareAuthDirectory(config) {
  await migrateWebDirectory(config, "auth", [
    "sessions.json",
    "maintenance-token",
  ]);
  const directory = join(config.configDir, "auth");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export async function openTotpStore(directory) {
  const path = join(directory, "totp.sqlite");
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
  db.exec(`
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS totp (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret BLOB,
      last_step INTEGER NOT NULL
    ) STRICT;
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS password_session_key (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key BLOB NOT NULL
  ) STRICT`);
  const read = db.prepare(`SELECT secret, last_step,
    (SELECT key FROM password_session_key WHERE id = 1) AS password_key
    FROM totp WHERE id = 1`);
  db.prepare("INSERT OR IGNORE INTO password_session_key VALUES (1, ?)").run(
    randomBytes(20),
  );
  const enroll = db.prepare(`
    INSERT INTO totp VALUES (1, ?, -1)
    ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, last_step = -1
    WHERE totp.secret IS NULL
  `);
  const consume = db.prepare(`
    UPDATE totp SET last_step = ? WHERE id = 1 AND secret = ? AND last_step < ?
  `);
  const disable = db.prepare(`
    INSERT INTO totp VALUES (1, NULL, -1)
    ON CONFLICT(id) DO UPDATE SET secret = NULL, last_step = -1
  `);
  const rotatePasswordKey = db.prepare(
    "UPDATE password_session_key SET key = ? WHERE id = 1",
  );
  return {
    close() {
      if (db.isOpen) db.close();
    },
    state() {
      const row = read.get();
      if (!row) return { status: "setup" };
      if (!row.secret)
        return {
          status: "disabled",
          binding: binding("password", row.password_key),
        };
      if (row.last_step < 0) return { status: "pending" };
      return { status: "enabled", binding: binding("totp", row.secret) };
    },
    setup(username) {
      enroll.run(randomBytes(20));
      const row = read.get();
      if (!row?.secret)
        throw new Error("双重验证设置已变更，请重新运行绑定命令。");
      if (row.last_step >= 0)
        throw new Error("验证器已绑定。换绑请先运行关闭命令，再重新绑定。");
      const issuer = "Claudex Web";
      const label = encodeURIComponent(issuer + ":" + username);
      return `otpauth://totp/${label}?secret=${base32(row.secret)}&issuer=${encodeURIComponent(issuer)}&period=${period}`;
    },
    disable() {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (read.get()?.secret !== null) {
          rotatePasswordKey.run(randomBytes(20));
          disable.run();
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    verify(code) {
      const row = read.get();
      if (!row) return { status: "unconfigured" };
      if (!row.secret) return { status: "disabled" };
      const entered = Buffer.from(code);
      const current = Math.floor(Date.now() / (period * 1000));
      for (const step of [current, current - 1, current + 1]) {
        if (step <= row.last_step) continue;
        if (timingSafeEqual(entered, Buffer.from(totpCode(row.secret, step))))
          return consume.run(step, row.secret, step).changes === 1
            ? { status: "verified", binding: binding("totp", row.secret) }
            : { status: "invalid" };
      }
      return { status: "invalid" };
    },
  };
}
