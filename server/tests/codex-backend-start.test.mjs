import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Codex 后端启动入口生成原生监听参数", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-backend-start-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "codex"),
    `#!${process.execPath}
console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }));
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}`,
    NODE_OPTIONS: "",
    CODEX_HOME: join(directory, "codex"),
    CLAUDE_CONFIG_DIR: join(directory, "claude"),
    CODEX_WEB_CONFIG_DIR: join(directory, "legacy"),
    CLAUDEX_WEB_CONFIG_DIR: join(directory, "config"),
    CLAUDEX_WEB_BACKENDS_FILE: join(directory, "backends.json"),
  };
  for (const [entry, args] of [
    ["bin/claudex-web.mjs", ["backend"]],
    ["scripts/start-backend.mjs", []],
  ]) {
    for (const [url, expected] of [
      ["ws://127.0.0.1:8765", "ws://127.0.0.1:8765"],
      ["ws://127.0.0.1:9876/", "ws://127.0.0.1:9876"],
      ["ws://[::1]:8765/", "ws://[::1]:8765"],
      ["ws://127.0.0.1:80/", "ws://127.0.0.1:80"],
      ["ws://127.0.0.1", "ws://127.0.0.1:80"],
    ]) {
      await t.test(`${entry} ${url}`, () => {
        const output = execFileSync(
          process.execPath,
          [join(root, entry), ...args],
          {
            env: { ...env, CODEX_APP_SERVER_URL: url },
            encoding: "utf8",
          },
        );
        assert.deepEqual(JSON.parse(output), {
          args: [
            "-c",
            "thread_unload_delay_secs=0",
            "app-server",
            "--listen",
            expected,
          ],
          home: join(directory, "codex"),
        });
      });
    }
    for (const url of [
      "wss://example.org/rpc",
      "ws://127.0.0.1:8765/rpc/",
      "ws://127.0.0.1:8765/?token=test",
      "ws://127.0.0.1:8765/#fragment",
    ]) {
      await t.test(`${entry} 拒绝用连接地址作为监听地址 ${url}`, () => {
        assert.throws(
          () =>
            execFileSync(process.execPath, [join(root, entry), ...args], {
              env: { ...env, CODEX_APP_SERVER_URL: url },
              encoding: "utf8",
              stdio: "pipe",
            }),
          (error) => {
            assert.equal(error.status, 1);
            assert.equal(error.stdout, "");
            assert.match(error.stderr, /Codex 本机监听地址须使用/);
            return true;
          },
        );
      });
    }
  }
});
