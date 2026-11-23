import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createBackendConfiguration } from "../src/backends/configuration.mjs";
import {
  createOpenCodeInstallation,
  runtimeDirectory,
  opencodeVersion,
} from "../src/backends/opencode/installation.mjs";
import { createOpenCodeTasks } from "../src/backends/opencode/tasks.mjs";
import { hasBackendWork } from "../../shared/backend-activity.mjs";

test("旧配置保留双后端与凭据，OpenCode 默认关闭且启停独立", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    configDir: root,
    codexHome: join(root, "codex"),
    claudeHome: join(root, "claude"),
    upstreamUrl: "ws://127.0.0.1:8765",
  };
  const existing = {
    version: 1,
    backends: [
      { id: "codex", type: "codex", enabled: true, hiddenModels: ["hidden"] },
      { id: "claude", type: "claude", enabled: true },
    ],
    providers: [{ id: "fixture", backendId: "claude", apiKey: "isolated-key" }],
  };
  await writeFile(join(root, "backends.json"), JSON.stringify(existing));
  const settings = createBackendConfiguration(config);
  const initial = await settings.read();
  assert.equal(initial.backends.length, 3);
  assert.equal(initial.backends[2].enabled, false);
  assert.deepEqual(initial.providers, existing.providers);
  for (const enabled of [true, false]) {
    await settings.save({ id: "opencode", type: "opencode", enabled });
    const restored = await createBackendConfiguration(config).read();
    assert.equal(restored.backends[2].enabled, enabled);
    assert.deepEqual(restored.backends[0].hiddenModels, ["hidden"]);
    assert.deepEqual(restored.providers, existing.providers);
  }
});

test("按需安装失败保留旧 SDK，重试验证成功后替换且清理暂存目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = join(
    runtimeDirectory(root),
    "node_modules/@opencode/sdk/package.json",
  );
  await mkdir(dirname(old), { recursive: true });
  await writeFile(
    old,
    JSON.stringify({ version: opencodeVersion, marker: "old" }),
  );
  let failure = true;
  const calls = [];
  const installation = createOpenCodeInstallation({
    configDir: root,
    changed: () => {},
    run: async (command, args) => {
      calls.push(args);
      if (args[0] === "install") {
        if (failure) throw new Error("simulated download failure");
        const manifest = join(
          args[2],
          "node_modules/@opencode/sdk/package.json",
        );
        await mkdir(dirname(manifest), { recursive: true });
        await writeFile(
          manifest,
          JSON.stringify({ version: opencodeVersion, marker: "new" }),
        );
      }
      return { stdout: "" };
    },
  });
  await assert.rejects(installation.install(), /download failure/);
  assert.equal(JSON.parse(await readFile(old)).marker, "old");
  failure = false;
  await installation.install();
  assert.equal(installation.state().installed, true);
  assert.equal(JSON.parse(await readFile(old)).marker, "new");
  assert.ok(
    calls.some((args) => args.includes(`@opencode/sdk@${opencodeVersion}`)),
  );
});

test("原生后台任务按会话隔离，结束任务释放执行服务占用", async () => {
  let status = "running";
  const stopped = [];
  const tasks = createOpenCodeTasks({
    sdk: () => ({
      experimental: {
        job: {
          list: async () => [
            {
              id: "job",
              kind: "shell",
              sessionID: "ses_a",
              shellID: "shell_a",
              command: "sleep 10",
              status,
              time: { started: 1 },
            },
          ],
        },
      },
      sessions: {
        get: async () => ({ location: { directory: "/tmp/fixture" } }),
      },
      shell: {
        remove: async (p) => {
          stopped.push(p);
          status = "cancelled";
        },
        output: async () => ({ data: { output: "test", truncated: false } }),
      },
    }),
    sessions: { nativeId: async () => "ses_a" },
    notify: () => {},
  });
  await tasks.refresh();
  assert.equal(hasBackendWork({ backgroundTasks: tasks.snapshot() }), true);
  const result = await tasks.request("thread/backgroundTasks/list", {
    threadId: "logical",
  });
  assert.equal(result.tasks[0].id, "job");
  await tasks.request("thread/backgroundTasks/cancel", {
    threadId: "logical",
    taskId: "job",
  });
  assert.equal(stopped[0].id, "shell_a");
  assert.equal(hasBackendWork({ backgroundTasks: tasks.snapshot() }), false);
  await assert.rejects(
    tasks.request("thread/backgroundTasks/cancel", {
      threadId: "logical",
      taskId: "other",
    }),
    /没有此后台任务/,
  );
});
