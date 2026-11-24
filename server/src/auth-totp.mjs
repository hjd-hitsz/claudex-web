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
const defaultName = "default";
const binding = (mode, key) =>
  mode + ":" + createHash("sha256").update(key).digest("hex");

function authenticatorName(value) {
  if (value === undefined || value === "") return defaultName;
  if (typeof value !== "string" || value.length > 64) return;
  const name = value.trim();
  if (name && !/[^\p{L}\p{M}\p{N} ._-]/u.test(name)) return name;
}

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initialize(db) {
  db.exec("PRAGMA secure_delete = ON");
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS totp_authenticators (
        name TEXT PRIMARY KEY,
        secret BLOB NOT NULL,
        binding TEXT NOT NULL UNIQUE,
        last_step INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS totp_password_only (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        binding TEXT NOT NULL
      ) STRICT;
    `);
    const legacy = db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'totp'",
    );
    if (!legacy.get()) return;
    const row = db.prepare("SELECT secret, last_step FROM totp").get();
    if (row?.secret) {
      db.prepare("INSERT INTO totp_authenticators VALUES (?, ?, ?, ?)").run(
        defaultName,
        row.secret,
        binding("totp", row.secret),
        row.last_step,
      );
    } else if (row) {
      const { key } = db.prepare("SELECT key FROM password_session_key").get();
      db.prepare("INSERT INTO totp_password_only VALUES (1, ?)").run(
        binding("password", key),
      );
    }
    db.exec("DROP TABLE totp; DROP TABLE IF EXISTS password_session_key");
  });
}

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
  try {
    initialize(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const read = db.prepare(
    "SELECT secret, binding, last_step FROM totp_authenticators WHERE name = ?",
  );
  const candidates = db.prepare(
    "SELECT secret, binding, last_step FROM totp_authenticators",
  );
  const readState = db.prepare(`
    SELECT
      EXISTS(SELECT 1 FROM totp_authenticators WHERE last_step >= 0) AS enabled,
      EXISTS(SELECT 1 FROM totp_authenticators) AS configured,
      (SELECT binding FROM totp_password_only) AS password_binding
  `);
  const enroll = db.prepare(`
    INSERT INTO totp_authenticators VALUES (?, ?, ?, -1)
    ON CONFLICT(name) DO NOTHING
  `);
  const consume = db.prepare(`
    UPDATE totp_authenticators SET last_step = ? WHERE binding = ? AND last_step < ?
  `);
  const active = db.prepare(`
    SELECT binding FROM totp_authenticators WHERE binding = ? AND last_step >= 0
    UNION ALL SELECT binding FROM totp_password_only WHERE binding = ?
  `);
  const list = db.prepare(
    "SELECT name, last_step >= 0 AS enabled FROM totp_authenticators ORDER BY name",
  );
  const remove = db.prepare("DELETE FROM totp_authenticators WHERE name = ?");
  function state() {
    const { enabled, configured, password_binding } = readState.get();
    if (password_binding)
      return { status: "disabled", binding: password_binding };
    return {
      status: enabled ? "enabled" : configured ? "pending" : "setup",
    };
  }
  return {
    close() {
      if (db.isOpen) db.close();
    },
    state,
    allowsBinding(value) {
      return typeof value === "string" && !!active.get(value, value);
    },
    setup(username, value) {
      const name = authenticatorName(value);
      if (!name) throw new Error("请输入有效的验证器名称。");
      const row = transaction(db, () => {
        const secret = randomBytes(20);
        enroll.run(name, secret, binding("totp", secret));
        const current = read.get(name);
        if (current.last_step >= 0)
          throw new Error(
            "验证器已绑定。可用其他名称添加，或撤销此名称后重新绑定。",
          );
        db.exec("DELETE FROM totp_password_only");
        return current;
      });
      const issuer = "Claudex Web";
      const account = name === defaultName ? username : `${username} (${name})`;
      const label = encodeURIComponent(issuer + ":" + account);
      return `otpauth://totp/${label}?secret=${base32(row.secret)}&issuer=${encodeURIComponent(issuer)}&period=${period}`;
    },
    list: () => list.all(),
    revoke(value) {
      const name = value && authenticatorName(value);
      if (!name) throw new Error("请输入有效的验证器名称。");
      if (!remove.run(name).changes) throw new Error("找不到该验证器。");
    },
    disable() {
      transaction(db, () => {
        db.exec("DELETE FROM totp_authenticators");
        db.prepare(
          "INSERT OR IGNORE INTO totp_password_only VALUES (1, ?)",
        ).run(binding("password", randomBytes(20)));
      });
    },
    verify(code) {
      if (typeof code !== "string" || !/^\d{6}$/.test(code))
        return { status: "invalid" };
      const entered = Buffer.from(code);
      const current = Math.floor(Date.now() / (period * 1000));
      const steps = [current + 1, current, current - 1];
      return transaction(db, () => {
        const rows = candidates.all();
        if (!rows.length)
          return {
            status: state().status === "disabled" ? "disabled" : "unconfigured",
          };
        let match;
        for (const row of rows) {
          const step = steps.find((step) =>
            timingSafeEqual(entered, Buffer.from(totpCode(row.secret, step))),
          );
          if (step === undefined) continue;
          // 已用的时间步也参与匹配，防止重放被归到另一个验证器。
          if (match) return { status: "ambiguous" };
          match = { row, step };
        }
        if (!match || match.step <= match.row.last_step)
          return { status: "invalid" };
        const { row, step } = match;
        return consume.run(step, row.binding, step).changes === 1
          ? { status: "verified", binding: row.binding }
          : { status: "invalid" };
      });
    },
  };
}
