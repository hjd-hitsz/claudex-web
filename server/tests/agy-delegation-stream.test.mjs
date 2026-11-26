import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createAgyStore } from "../src/backends/agy/session-store.mjs";
import { createBackendConfiguration } from "../src/backends/configuration.mjs";
import { createDelegationRuntime } from "../src/backends/delegation/runtime.mjs";
import { runtimeIdentity } from "../src/conversation-manager/address.mjs";

test(
  "委派流式事件有序转发，同批更新共用任务状态读取",
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "claudex-delegation-stream-"));
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(upstream, "listening");
    let runtime;
    try {
      const config = {
        configDir: root,
        defaultCwd: root,
        codexHome: root,
        claudeHome: root,
        backendsFile: join(root, "backends.json"),
        upstreamUrl: "ws://127.0.0.1:" + upstream.address().port,
      };
      const { backends } = await createBackendConfiguration(config).read();
      const backend = backends.find(({ id }) => id === "codex");
      const state = {
        sessions: {},
        tasks: {
          task: {
            id: "task",
            parentId: "parent",
            target: "codex",
            status: "running",
            executor: {
              runtimeId: runtimeIdentity(backend),
              threadId: "child",
            },
            selection: {},
            steps: [{ id: "step", turnId: "turn" }],
          },
        },
        notices: {},
      };
      await writeFile(join(root, "state.json"), JSON.stringify(state));
      const store = createAgyStore(root);
      const expected = Array.from({ length: 192 }, (_, index) => String(index));
      const received = [];
      const last = Promise.withResolvers();
      let reads = 0;
      let readsBeforeBurst;
      runtime = createDelegationRuntime({
        config,
        store: {
          ...store,
          read() {
            reads++;
            return store.read();
          },
        },
        version: { displayVersion: "fixture" },
        emit({ method, params }) {
          if (method !== "item/agentMessage/delta") return;
          received.push([params.threadId, params.delta]);
          if (params.delta === expected.at(-1)) last.resolve();
        },
      });
      upstream.on("connection", (client) => {
        const send = (message) => client.send(JSON.stringify(message));
        client.on("message", (raw) => {
          const { id, method } = JSON.parse(raw);
          if (id === undefined) return;
          if (method !== "thread/read") return send({ id, result: {} });
          send({
            id,
            result: {
              thread: {
                id: "child",
                turns: [{ id: "turn", status: "inProgress" }],
              },
            },
          });
          if (readsBeforeBurst !== undefined) return;
          readsBeforeBurst = reads;
          for (const delta of expected) {
            send({
              method: "item/agentMessage/delta",
              params: {
                threadId: "child",
                turnId: "turn",
                itemId: "item",
                delta,
              },
            });
            send({
              method: "thread/tokenUsage/updated",
              params: { threadId: "other" },
            });
          }
        });
      });
      runtime.wake();
      await last.promise;
      assert.deepEqual(
        received,
        expected.map((delta) => ["delegation/task", delta]),
      );
      assert.ok(reads - readsBeforeBurst < 16, "流式通知不逐条读取状态文件");
    } finally {
      runtime?.close();
      for (const client of upstream.clients) client.terminate();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);
