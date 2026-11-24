import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { createDelivery } from "../../packages/background-terminal/delivery.mjs";

for (const finish of ["notification", "before-response", "disconnect"]) {
  test(`后台续跑在 ${finish} 时释放原生订阅`, { timeout: 6000 }, async (t) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const accepted = Promise.withResolvers();
    const disconnected = Promise.withResolvers();
    const job = {
      id: "job",
      threadId: "thread",
      completedAt: 1,
      delivery: "pending",
    };
    const batch = { id: "batch", jobIds: [job.id], deliveryJobIds: [job.id] };
    let socket;
    function finishTurn(threadId, id) {
      socket.send(
        JSON.stringify({
          method: "turn/completed",
          params: { threadId, turn: { id, status: "completed" } },
        }),
      );
    }
    server.on("connection", (connection) => {
      socket = connection;
      socket.once("close", disconnected.resolve);
      socket.on("message", (bytes) => {
        const { id, method } = JSON.parse(bytes);
        if (!id) return;
        if (method === "turn/start" && finish === "before-response")
          finishTurn("thread", "wake");
        const result =
          {
            "thread/read": { thread: {} },
            "thread/resume": { thread: {} },
            "turn/start": { turn: { id: "wake", status: "inProgress" } },
          }[method] ?? {};
        socket.send(JSON.stringify({ id, result }));
      });
    });
    const stop = createDelivery(
      "/tmp",
      `ws://127.0.0.1:${server.address().port}`,
      {
        snapshot: () => ({ jobs: [job], batches: [], dueChecks: [] }),
        claim: async () => batch,
        readyToSend: () => batch.deliveryJobIds,
        read: async () => ({ job, output: "" }),
        async updateBatch({ status, turnId }) {
          job.delivery = status;
          if (status === "accepted") accepted.resolve(turnId);
          return { ...batch, status };
        },
      },
    );
    t.after(async () => {
      for (const connection of server.clients) connection.terminate();
      await stop();
      await new Promise((resolve) => server.close(resolve));
    });
    assert.equal(await accepted.promise, "wake");
    if (finish !== "before-response") {
      finishTurn("other-thread", "wake");
      finishTurn("thread", "previous");
      await delay(75);
      assert.equal(socket.readyState, WebSocket.OPEN);
      if (finish === "disconnect") socket.terminate();
      else finishTurn("thread", "wake");
    }
    await disconnected.promise;
    assert.equal(job.delivery, "accepted");
  });
}
