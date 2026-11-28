import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { delegationModeRequests } from "../src/backends/delegation/mode-requests.mjs";
import {
  createDelegationModes,
  delegationModesPath,
} from "../src/backends/delegation/source-modes.mjs";
import { runtimeIdentity } from "../src/conversation-manager/address.mjs";
import { delegationRecordsPath } from "../../packages/background-terminal/delegation-records.mjs";
import { verifyPendingClaudeSecretary } from "../src/backends/claude/secretary-policy.mjs";
import { createBackgroundResume } from "../../packages/background-terminal/thread-policy.mjs";

test("首轮创建分别持久化 Codex 和 Claude 的委派开关，重读恢复已保存的状态", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-delegation-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modes = delegationModeRequests(createDelegationModes(directory), true);
  for (const id of ["codex", "claude"]) {
    const backend = { id, type: id };
    const { forwarded, selectedMode } = await modes.forward(
      backend,
      "thread/start",
      { delegationMode: true },
    );
    assert.equal(forwarded.delegationMode, true);
    const result = {
      thread: { id: "created" },
      ...(id === "claude" && { delegationMode: true }),
    };
    const started = await modes.project(
      backend,
      "thread/start",
      result,
      selectedMode,
    );
    assert.equal(started.thread.delegationMode, true);

    const restored = delegationModeRequests(
      createDelegationModes(directory),
      true,
    );
    const read = await restored.project(backend, "thread/read", {
      thread: result.thread,
    });
    assert.equal(read.thread.delegationMode, true);
    const other = await restored.project(backend, "thread/read", {
      thread: { id: "other" },
    });
    assert.equal(other.thread.delegationMode, false);
    if (id === "codex") {
      const { forwarded, selectedMode } = await restored.forward(
        backend,
        "thread/fork",
        { threadId: "created", delegationMode: false },
      );
      assert.equal(forwarded.delegationMode, true);
      await restored.project(
        backend,
        "thread/fork",
        { thread: { id: "forked" } },
        selectedMode,
      );
      const fork = await restored.project(backend, "thread/resume", {
        thread: { id: "forked" },
      });
      assert.equal(fork.thread.delegationMode, true);
      const ordinary = await restored.forward(backend, "thread/fork", {
        threadId: "other",
        delegationMode: true,
      });
      assert.equal(ordinary.forwarded.delegationMode, false);
    }
  }
});

test("Codex 后台恢复读取所属运行时的委派模式并保留执行端配置", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-background-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = { id: "codex", type: "codex", url: "ws://127.0.0.1:1/" };
  const modes = createDelegationModes(directory);
  await modes.save(backend, "secretary", true);
  await modes.save({ ...backend, url: "ws://127.0.0.1:2/" }, "other", true);
  await writeFile(
    delegationRecordsPath(directory),
    JSON.stringify({
      paths: [],
      modesPath: delegationModesPath(directory),
      runtimeId: runtimeIdentity(backend),
    }),
  );
  const resume = createBackgroundResume(directory);
  const call = async (method, params) =>
    method === "thread/read" ? { thread: { cwd: directory } } : params;
  const config = { custom: true };
  const params = { threadId: "secretary", config };
  await assert.rejects(resume(call, params), /转换为干净秘书续接/);
  await modes.save(backend, "secretary", true, true);
  const result = await resume(call, params);
  assert.equal(result.cwd, directory);
  assert.equal(result.config.project_doc_max_bytes, 0);
  assert.equal(result.config.projects[directory].trust_level, "untrusted");
  assert.equal(result.config.custom, true);
  assert.deepEqual(await resume(call, params, { research: true }), params);
  const ordinary = { threadId: "other", config };
  assert.deepEqual(await resume(call, ordinary), ordinary);
  await modes.save(backend, "secretary", false);
  assert.deepEqual(await resume(call, params), params);
});

test("Claude 桥接等待旧 Worker 退出时先读取角色并拦截旧秘书", async () => {
  const operations = [];
  const read = async (request) => {
    operations.push(request.message.method);
    return { result: { thread: { delegationMode: true } } };
  };
  await assert.rejects(
    verifyPendingClaudeSecretary(true, "fixture", read),
    /转换为干净秘书续接/,
  );
  assert.deepEqual(operations, ["thread/read"]);
  await verifyPendingClaudeSecretary(false, "fixture", read);
  assert.deepEqual(operations, ["thread/read"]);
  await verifyPendingClaudeSecretary(true, "fixture", async () => ({
    result: { thread: { delegationMode: false } },
  }));
});
