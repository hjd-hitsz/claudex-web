import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { validateBackend } from "../src/backends/configuration.mjs";
import { runtimeIdentity } from "../src/conversation-manager/address.mjs";
import { agyBackgroundMethods } from "../src/backends/agy/tmp_function/background-tasks.mjs";
import {
  agyPluginMethods,
  parseAgyMcp,
  parseAgyPlugins,
} from "../src/backends/agy/tmp_function/plugin-status.mjs";

const config = {
  configDir: "/fixture",
  codexHome: "/fixture/codex",
  upstreamUrl: "ws://127.0.0.1:8765",
};
const runtimeId = runtimeIdentity(
  validateBackend({ id: "codex", type: "codex" }, config),
);
const tasks = [
  ["parent", "codex", "delegate", runtimeId],
  ["parent", "codex", "unavailable", runtimeId],
  ["parent", "codex", "old-backend", "obsolete-runtime"],
  ["parent", "claude", "claude", runtimeId],
  ["other", "codex", "other-delegate", runtimeId],
].map(([parentId, target, threadId, runtimeId]) => ({
  parentId,
  target,
  executor: { threadId, runtimeId },
}));

test("agy 后台面板只读取当前会话委派的 Claudex 进程，并隔离失败", async () => {
  const job = {
    id: randomUUID(),
    threadId: "delegate",
    status: "running",
    title: "构建",
    command: "npm run build",
    cwd: "/fixture/workspace",
  };
  const native = { ...job, id: randomUUID(), native: { processId: "42" } };
  const foreign = { ...job, id: randomUUID(), threadId: "other-delegate" };
  const calls = [];
  let offline = false;
  const handler = agyBackgroundMethods({
    config,
    store: {
      read: async () => ({ tasks }),
      session: (_state, id) => ({ id }),
    },
    request: async (directory, method, params) => {
      assert.equal(directory, "/fixture/background-terminal");
      assert.equal(method, "tool");
      calls.push(params);
      if (params.threadId === "unavailable")
        throw Object.assign(new Error("离线"), { code: "ECONNREFUSED" });
      if (offline) throw new Error("读取失败");
      return {
        jobs: [job, native, foreign],
      };
    },
    resolveDirectory: async (path) => path,
    readLog: async (path, offset, limit) => {
      assert.equal(path, `/fixture/background-terminal/output-${job.id}.log`);
      assert.equal(offset, undefined);
      assert.equal(limit, 8192);
      return { output: "build log", offset: 1 };
    },
  });
  const parent = { threadId: "parent" };
  const list = handler.get("thread/backgroundTasks/list");
  assert.deepEqual(await list({ threadId: "empty" }), { tasks: [] });
  assert.deepEqual(calls, []);
  assert.deepEqual(
    (await list(parent)).tasks.map(({ id }) => id),
    [job.id],
  );
  assert.deepEqual(
    await handler.get("thread/backgroundTerminals/list")(parent),
    {
      data: [{ processId: job.id, command: job.command, cwd: job.cwd }],
      nextCursor: null,
    },
  );
  const result = await handler.get("thread/backgroundTasks/read")({
    ...parent,
    taskId: job.id,
  });
  assert.equal(result.output, "build log");
  assert.equal(result.truncated, true);
  const cancel = handler.get("thread/backgroundTasks/cancel");
  for (const taskId of [native.id, foreign.id])
    await assert.rejects(cancel({ ...parent, taskId }), /没有此后台终端/);
  await cancel({ ...parent, taskId: job.id });
  await handler.get("thread/backgroundTerminals/clean")(parent);
  const expectedCancel = {
    name: "background_cancel",
    args: { job_id: job.id },
    threadId: "delegate",
    expectedUpstream: "ws://127.0.0.1:8765/",
  };
  assert.deepEqual(
    calls.filter(({ name }) => name === "background_cancel"),
    [expectedCancel, expectedCancel],
  );
  assert.deepEqual(
    new Set(calls.map(({ threadId }) => threadId)),
    new Set(["delegate", "unavailable"]),
  );
  offline = true;
  assert.deepEqual(await list(parent), { tasks: [] });
  await assert.rejects(
    handler.get("thread/backgroundTerminals/clean")(parent),
    /暂时无法停止/,
  );
});

test("agy 插件和 MCP 目录解析保留启停状态并忽略启动配置", () => {
  assert.deepEqual(parseAgyPlugins("[]"), []);
  assert.deepEqual(
    parseAgyPlugins('[{"name":"tool","enabled":false,"path":"/private"}]'),
    [{ name: "tool", enabled: false }],
  );
  assert.deepEqual(parseAgyMcp("No MCP servers configured.\n"), []);
  assert.deepEqual(
    parseAgyMcp(
      "NAME       TYPE   STATUS    COMMAND/URL\n" +
        "two words  stdio  disabled  /bin/echo fake\n" +
        "点子         http   enabled   https://example.invalid/?token=fake\n",
    ),
    [
      { name: "two words", status: "disabled" },
      { name: "点子", status: "configured" },
    ],
  );
  assert.throws(() => parseAgyMcp("Unexpected output"), /无效的/);
  assert.throws(() => parseAgyPlugins('[{"name":"unknown"}]'), /无效的/);
});

test("agy 列表独立读取，委派 MCP 状态按 ACP 会话隔离", async () => {
  const entries = new Map([
    ["open", { toolsReady: true, mcpTools: ["read_delegation_step"] }],
    ["pending", { toolsReady: true }],
  ]);
  let failed;
  const handlers = agyPluginMethods({
    getBackend: () => ({ executable: "/fixture/agy" }),
    defaultCwd: "/fixture",
    entries,
    execCli: async (cli, [kind, list, json], { cwd }) => {
      assert.equal(cli, "/fixture/agy");
      assert.equal(cwd, "/fixture");
      assert.equal(list, "list");
      assert.equal(json, kind === "plugin" ? "--json" : undefined);
      if (failed === kind) throw new Error("CLI unavailable");
      return {
        stdout: kind === "plugin" ? "[]" : "No MCP servers configured.",
      };
    },
  });
  const plugins = handlers.get("plugin/installed");
  const mcp = handlers.get("mcpServerStatus/list");
  assert.deepEqual(await plugins({}), { marketplaces: [], unavailable: false });
  const live = {
    name: "claudex_delegation",
    status: "connected",
    tools: { read_delegation_step: {} },
  };
  assert.deepEqual((await mcp({ threadId: "open" })).data, [live]);
  assert.deepEqual((await mcp({ threadId: "pending" })).data, []);
  failed = "plugin";
  assert.deepEqual(await plugins({}), { marketplaces: [], unavailable: true });
  assert.deepEqual((await mcp({ threadId: "open" })).data, [live]);
  failed = "mcp";
  assert.deepEqual(await mcp({ threadId: "open" }), {
    data: [live],
    nextCursor: null,
    unavailable: true,
  });
  entries.delete("open");
  assert.deepEqual((await mcp({ threadId: "open" })).data, []);
});
