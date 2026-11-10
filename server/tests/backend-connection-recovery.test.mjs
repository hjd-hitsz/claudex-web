import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendManager } from "../src/backends/manager.mjs";

for (const id of ["codex", "claude"]) {
  test(`${id} 首次连接失败后恢复，清除旧错误并继续报告后续故障`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "backend-recovery-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "backends.json");
    await writeFile(
      path,
      JSON.stringify({
        backends: [
          { id: "codex", type: "codex", enabled: id === "codex" },
          { id: "claude", type: "claude", enabled: id === "claude" },
        ],
        providers: [],
      }),
    );
    let adapter;
    const updates = [];
    const factory = ({ broadcast }) => {
      adapter = {
        ready: false,
        snapshot: { ready: false, error: null, activeTurns: {}, questions: [] },
        state() {
          return { params: this.snapshot };
        },
        async connect() {
          throw new Error("socket missing");
        },
        notify() {
          broadcast({ method: "lan/state", params: this.snapshot });
        },
        close() {},
      };
      return adapter;
    };
    const manager = createBackendManager({
      config: {
        configDir: directory,
        codexHome: directory,
        claudeHome: directory,
        backendsFile: path,
        upstreamUrl: "ws://127.0.0.1:1",
      },
      version: {},
      send() {},
      broadcast: (message) => updates.push(message),
      factories: { [id]: factory, installation: { state: () => ({}) } },
    });
    t.after(() => manager.close());
    await manager.connect();
    const current = () =>
      manager.state().params.backends.find((b) => b.id === id);
    assert.equal(current().error, "socket missing");
    adapter.ready = true;
    adapter.snapshot = { ...adapter.snapshot, ready: true };
    adapter.notify();
    assert.equal(current().ready, true);
    assert.equal(current().error, null);
    assert.equal(
      updates.at(-1).params.backends.find((b) => b.id === id).error,
      null,
    );
    adapter.ready = false;
    adapter.snapshot = {
      ...adapter.snapshot,
      ready: false,
      error: "connection lost",
    };
    adapter.notify();
    assert.equal(current().error, "connection lost");
  });
}
