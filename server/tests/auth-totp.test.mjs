import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openTotpStore, totpCode } from "../src/auth-totp.mjs";

test("迁移单绑定数据库时保留密钥、使用过的时间步和会话凭据", async (t) => {
  const secret = Buffer.from("12345678901234567890");
  const fingerprint = createHash("sha256").update(secret).digest("hex");
  const step = Math.floor(Date.now() / 30000);
  for (const [status, lastStep] of [
    ["setup", -1],
    ["disabled", -1],
    ["pending", -1],
    ["enabled", step],
  ]) {
    await t.test(status, async () => {
      const directory = await mkdtemp(join(tmpdir(), "claudex-totp-legacy-"));
      try {
        const db = new DatabaseSync(join(directory, "totp.sqlite"));
        try {
          db.exec(`
            CREATE TABLE totp (id INTEGER PRIMARY KEY CHECK (id = 1), secret BLOB, last_step INTEGER NOT NULL) STRICT;
            CREATE TABLE password_session_key (id INTEGER PRIMARY KEY CHECK (id = 1), key BLOB NOT NULL) STRICT;
          `);
          db.prepare("INSERT INTO password_session_key VALUES (1, ?)").run(
            secret,
          );
          if (status !== "setup")
            db.prepare("INSERT INTO totp VALUES (1, ?, ?)").run(
              status === "disabled" ? null : secret,
              lastStep,
            );
        } finally {
          db.close();
        }
        for (let reopen = 0; reopen < 2; reopen++) {
          const store = await openTotpStore(directory);
          try {
            assert.equal(store.state().status, status);
            assert.equal(
              store.allowsBinding("totp:" + fingerprint),
              status === "enabled",
            );
            assert.equal(
              store.allowsBinding("password:" + fingerprint),
              status === "disabled",
            );
            if (status === "enabled")
              assert.equal(
                store.verify(totpCode(secret, step)).status,
                "invalid",
              );
            if (status === "pending")
              assert.match(
                store.setup("fixture"),
                /secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/,
              );
          } finally {
            store.close();
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("只配置命名验证器时按名称验证，撤销最后一个后要求重新绑定", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-totp-named-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openTotpStore(directory);
  t.after(() => store.close());
  store.disable();
  const { binding } = store.state();
  assert.throws(() => store.setup("fixture", "无效:名字"), /有效的验证器名称/);
  assert.equal(store.allowsBinding(binding), true);
  store.setup("fixture", "工作手机");
  assert.deepEqual(store.state(), { status: "pending", totpName: "required" });
  assert.equal(store.allowsBinding(binding), false);
  assert.equal(store.verify("123456").status, "invalid");
  store.revoke("工作手机");
  assert.deepEqual(store.state(), { status: "setup" });
  assert.equal(store.verify("123456").status, "unconfigured");
});
