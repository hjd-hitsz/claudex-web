import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { createBackendManager } from "../src/backends/manager.mjs";

test(
  "Codex 适配器保持连接，原生新建、恢复和分支读取最新子代理偏好",
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-subagent-settings-"));
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const requests = [];
    let connections = 0;
    server.on("connection", (socket) => {
      connections++;
      socket.on("message", (bytes) => {
        const message = JSON.parse(bytes);
        requests.push(message);
        if (!message.method || message.id === undefined) return;
        const result =
          message.method === "initialize"
            ? {}
            : message.method === "thread/list"
              ? { data: [] }
              : message.method === "thread/unsubscribe"
                ? { status: "unsubscribed" }
                : {
                    thread: {
                      id: "thread",
                      cwd: root,
                      turns: [],
                      status: { type: "idle" },
                    },
                  };
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });
    const path = join(root, "backends.json");
    await writeFile(
      path,
      JSON.stringify({
        backends: [
          { id: "codex", type: "codex", enabled: true },
          { id: "claude", type: "claude", enabled: false },
        ],
        providers: [],
      }),
    );
    const manager = createBackendManager({
      config: {
        configDir: root,
        backendsFile: path,
        codexHome: root,
        claudeHome: root,
        upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
        defaultCwd: root,
      },
      version: { displayVersion: "test" },
      send: (client, message) => client.deliver(message),
      broadcast() {},
      factories: { installation: { state: () => ({}) } },
    });
    let sequence = 0;
    const call = (method, params) =>
      new Promise((resolve, reject) => {
        manager
          .receive(
            {
              readyState: 1,
              deliver: (message) =>
                message.error
                  ? reject(new Error(message.error.message))
                  : resolve(message.result),
            },
            { id: ++sequence, method, params },
          )
          .catch(reject);
      });
    try {
      await manager.connect();
      while (!manager.ready) await delay(1);
      for (const [model, effort] of [
        ["child-first", "low"],
        ["child-next", "high"],
        ["", ""],
      ]) {
        await call("lan/backends/save", {
          id: "codex",
          type: "codex",
          subagentModel: model,
          subagentEffort: effort,
        });
        for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
          await call(method, {
            threadId: "thread",
            cwd: root,
            model: "parent",
          });
          const native = requests.findLast(
            (request) => request.method === method,
          ).params;
          assert.equal(
            native.config["agents.default_subagent_model"],
            model || undefined,
          );
          assert.equal(
            native.config["agents.default_subagent_reasoning_effort"],
            effort || undefined,
          );
          assert.equal(native.model, "parent");
        }
        assert.equal(connections, 1);
        assert.equal(manager.ready, true);
      }
      await writeFile(path, "invalid-json");
      const before = requests.length;
      await assert.rejects(call("thread/start", { cwd: root }), /JSON/);
      assert.equal(
        requests
          .slice(before)
          .some((request) => request.method === "thread/start"),
        false,
      );
    } finally {
      await manager.close();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
