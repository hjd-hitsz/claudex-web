import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendManager } from "../src/backends/manager.mjs";

test("双后端实时统计在桥接持久化，重启后的轻量读取和恢复携带所属统计", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "usage-routing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "backends.json");
  await writeFile(
    path,
    JSON.stringify({
      backends: [
        { id: "codex", type: "codex", enabled: true },
        { id: "claude", type: "claude", enabled: true },
      ],
      providers: [],
    }),
  );
  const emitters = {};
  const seen = [];
  const factory = ({ backend, send, broadcast }) => {
    emitters[backend.id] = broadcast;
    return {
      ready: true,
      connect() {},
      close() {},
      state: () => ({ params: { activeTurns: {}, questions: [] } }),
      receive(client, message) {
        if (message.method === "thread/list")
          return send(client, { id: message.id, result: { data: [] } });
        seen.push(message);
        send(client, {
          id: message.id,
          result: {
            thread: {
              id:
                message.method === "thread/fork"
                  ? `branch-${message.params.threadId}`
                  : message.params.threadId,
              turns: [],
            },
          },
        });
      },
    };
  };
  const create = () =>
    createBackendManager({
      config: {
        configDir: directory,
        upstreamUrl: "ws://127.0.0.1:8765",
        claudeHome: directory,
        codexHome: directory,
        backendsFile: path,
      },
      version: {},
      send: (client, message) => client.deliver(message),
      broadcast() {},
      factories: {
        codex: factory,
        claude: factory,
        installation: { state: () => ({}) },
      },
    });
  let manager = create();
  t.after(() => manager.close());
  const request = (method, threadId) =>
    new Promise((resolve, reject) => {
      manager
        .receive(
          { readyState: 1, deliver: (message) => resolve(message.result) },
          {
            id: 1,
            method,
            params: { threadId, includeTurns: false, excludeTurns: true },
          },
        )
        .catch(reject);
    });
  await manager.connect();
  for (const [backendId, count] of [
    ["codex", 123],
    ["claude", 456],
  ])
    emitters[backendId]({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "same",
        tokenUsage: { last: { totalTokens: count }, modelContextWindow: 1000 },
      },
    });
  await manager.close();
  manager = create();
  await manager.connect();
  for (const method of ["thread/read", "thread/resume"]) {
    assert.equal(
      (await request(method, "same")).thread.tokenUsage.last.totalTokens,
      123,
    );
    assert.equal(
      (await request(method, "backend:claude:same")).thread.tokenUsage.last
        .totalTokens,
      456,
    );
    assert.equal(seen.at(-1).params.excludeTurns, true);
    assert.deepEqual((await request(method, "new")).thread.turns, []);
  }
  for (const [id, count] of [
    ["same", 123],
    ["backend:claude:same", 456],
  ]) {
    const branch = await request("thread/fork", id);
    assert.equal(branch.thread.tokenUsage.last.totalTokens, count);
    assert.equal(
      (await request("thread/read", branch.thread.id)).thread.tokenUsage.last
        .totalTokens,
      count,
    );
  }
  await request("thread/archive", "same");
  await manager.close();
  manager = create();
  await manager.connect();
  assert.equal(
    (await request("thread/read", "same")).thread.tokenUsage,
    undefined,
  );
  await request("thread/unarchive", "same");
  emitters.codex({
    method: "thread/tokenUsage/updated",
    params: { threadId: "same", tokenUsage: { last: { totalTokens: 789 } } },
  });
  assert.equal(
    (await request("thread/read", "same")).thread.tokenUsage.last.totalTokens,
    789,
  );
});
