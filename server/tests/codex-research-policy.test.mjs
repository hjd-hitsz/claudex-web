import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createResearchThreadLookup } from "../../packages/background-terminal/delegation-records.mjs";
import {
  checkWebResearchAccess,
  researchSessionParams,
} from "../src/backends/codex/research-policy.mjs";
import { delegationStatePaths } from "../src/backends/delegation/delegated-threads.mjs";
import {
  delegationStartParams,
  delegationTurnParams,
} from "../src/backends/delegation/executors.mjs";

test("Codex 委派在线程和轮次使用各自的原生沙箱字段", () => {
  const task = {
    target: "codex",
    cwd: "/fixture",
    selection: { model: "fixture-model", effort: "high" },
    executor: { threadId: "executor" },
    steps: [{ id: "step", request: "检查文件" }],
  };
  for (const [scope, sandbox, sandboxPolicy] of [
    ["research", "read-only", { type: "readOnly", networkAccess: false }],
    ["implementation", "danger-full-access", { type: "dangerFullAccess" }],
  ]) {
    const scoped = { ...task, scope };
    assert.deepEqual(delegationStartParams(scoped), {
      cwd: "/fixture",
      model: "fixture-model",
      approvalPolicy: "never",
      sandbox,
    });
    const { input, ...turn } = delegationTurnParams(scoped);
    assert.equal(input.length, 2);
    assert.deepEqual(turn, {
      threadId: "executor",
      model: "fixture-model",
      effort: "high",
      approvalPolicy: "never",
      sandboxPolicy,
    });
  }
});

test("网页只能按 ID 恢复研究线程及查看历史", () => {
  const params = {
    threadId: "research",
    excludeTurns: true,
    cwd: "/elsewhere",
    sandbox: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" },
    approvalPolicy: "on-request",
    permissions: ":danger-full-access",
    config: { "mcp_servers.claudex_background.enabled": true },
  };
  assert.doesNotThrow(() =>
    checkWebResearchAccess("thread/resume", params, true),
  );
  assert.deepEqual(researchSessionParams("thread/resume", params, true), {
    threadId: "research",
    excludeTurns: true,
    initialTurnsPage: undefined,
    sandbox: "read-only",
    approvalPolicy: "never",
    config: {
      "mcp_servers.claudex_background": {
        command: process.execPath,
        enabled: false,
      },
    },
  });
  for (const method of [
    "command/exec",
    "thread/fork",
    "thread/goal/set",
    "thread/queue/start",
    "thread/settings/update",
    "thread/shellCommand",
    "turn/start",
  ]) {
    assert.throws(
      () => checkWebResearchAccess(method, params, true),
      /只读执行/,
    );
    assert.doesNotThrow(() => checkWebResearchAccess(method, params, false));
  }
  assert.throws(
    () => checkWebResearchAccess("thread/resume", { path: "/rollout" }, false),
    /会话 ID/,
  );
  assert.throws(
    () => checkWebResearchAccess("thread/resume", { history: [] }, false),
    /会话 ID/,
  );
});

test("研究归属来自两个持久账本，包含已完成的旧委派", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-research-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = delegationStatePaths(directory);
  const belongs = createResearchThreadLookup({ paths, runtimeId: "runtime" });
  const record = (threadId, scope = "research", runtimeId = "runtime") => ({
    target: "codex",
    scope,
    status: "completed",
    executor: { threadId, runtimeId },
  });
  assert.equal(await belongs("old"), false);
  for (const path of paths) await mkdir(dirname(path), { recursive: true });
  await writeFile(
    paths[0],
    JSON.stringify({ tasks: { previous: record("old") } }),
  );
  await writeFile(
    paths[1],
    JSON.stringify({
      tasks: {
        current: record("current"),
        implementation: record("implementation", "implementation"),
        foreign: record("foreign", "research", "other-runtime"),
      },
    }),
  );
  assert.equal(await belongs("old"), true);
  assert.equal(await belongs("current"), true);
  assert.equal(await belongs("implementation"), false);
  assert.equal(await belongs("foreign"), false);
  const replacement = paths[1] + ".tmp";
  await writeFile(
    replacement,
    JSON.stringify({ tasks: { new: record("new") } }),
  );
  await rename(replacement, paths[1]);
  assert.equal(await belongs("new"), true);
  assert.equal(await belongs("current"), false);
  assert.equal(await belongs("old"), true);
});
