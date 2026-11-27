import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { delegationModeRequests } from "../src/backends/delegation/mode-requests.mjs";
import { createDelegationModes } from "../src/backends/delegation/source-modes.mjs";

test("首轮创建分别持久化 Codex 和 Claude 的委派开关，重读恢复已保存的状态", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-delegation-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modes = delegationModeRequests(createDelegationModes(directory), true);
  for (const id of ["codex", "claude"]) {
    const backend = { id, type: id };
    const { forwarded, selectedMode } = modes.forward(backend, "thread/start", {
      delegationMode: true,
    });
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
  }
});
