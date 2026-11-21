import test from "node:test";
import assert from "node:assert/strict";
import { bridge } from "../../tests/helpers/bridge.mjs";

test("Codex 历史首屏返回同一轮次已收到的未完成正文", async (t) => {
  const app = await bridge(t, (request, socket) => {
    if (request.method !== "thread/items/list") return false;
    assert.equal(Object.hasOwn(request.params, "includeStreaming"), false);
    socket.send(JSON.stringify({ id: request.id, result: { data: [] } }));
    return true;
  });
  const firstClient = await app.connect();
  const threadId = "active-thread";
  const turnId = "current-turn";
  const item = { id: "answer", type: "agentMessage", phase: "final_answer" };
  const delta = (threadId, delta) =>
    app.notify("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: item.id,
      delta,
    });
  app.notify("turn/started", { threadId, turn: { id: turnId } });
  app.notify("item/started", { threadId, turnId, item: { ...item, text: "" } });
  delta(threadId, "开头");
  const secondClient = await app.connect();
  const read = (params) =>
    app.rpc(secondClient, "thread/items/list", { threadId, ...params });
  delta("other-thread", "另一个对话");
  delta(threadId, "仍在生成");
  assert.deepEqual(await read({ includeStreaming: true }), {
    data: [],
    streamingMessages: [{ ...item, turnId, text: "开头仍在生成" }],
  });
  assert.deepEqual(await read({ includeStreaming: true, cursor: "older" }), {
    data: [],
  });
  assert.deepEqual(await read(), { data: [] });
  app.notify("item/completed", {
    threadId,
    turnId,
    item: { ...item, text: "开头仍在生成，最后完成。" },
  });
  assert.deepEqual(await read({ includeStreaming: true }), { data: [] });
  delta(threadId, "中断前收到的正文");
  app.notify("turn/completed", {
    threadId,
    turn: { id: turnId, status: "interrupted" },
  });
  assert.deepEqual(await read({ includeStreaming: true }), { data: [] });
  firstClient.close();
});
