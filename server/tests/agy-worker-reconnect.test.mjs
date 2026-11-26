import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgyWorkerAdapter } from "../src/backends/agy/worker-client.mjs";
import {
  privateDirectory,
  receiveIpc,
  sendIpc,
  workerLocation,
} from "../src/backends/agy/worker-ipc.mjs";

test(
  "agy 首次 IPC 连接失败后继续重试并发布就绪状态",
  { timeout: 7000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-ipc-retry-"));
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = root;
    const stateDir = join(root, "state");
    const location = workerLocation(stateDir);
    const connected = Promise.withResolvers();
    const ready = {
      method: "lan/state",
      params: { ready: true, questions: [] },
    };
    const adapter = createAgyWorkerAdapter({
      backend: { stateDir },
      broadcast: connected.resolve,
    });
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      receiveIpc(socket, ({ id }) => sendIpc(socket, { id, result: ready }));
    });
    try {
      await privateDirectory(location.directory);
      await writeFile(location.socket, "", { mode: 0o600 });
      await assert.rejects(adapter.connect(), /IPC socket/);
      await rm(location.socket);
      server.listen(location.socket);
      await once(server, "listening");
      await chmod(location.socket, 0o600);
      assert.deepEqual(await connected.promise, ready);
      assert.equal(adapter.ready, true);
    } finally {
      adapter.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (runtimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = runtimeDirectory;
      await rm(root, { recursive: true, force: true });
    }
  },
);
