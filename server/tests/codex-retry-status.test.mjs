import assert from "node:assert/strict";
import test from "node:test";
import { bridge, waitFor } from "../../tests/helpers/bridge.mjs";

test("Codex 重试状态随轮次进展、结束与连接快照更新", async (t) => {
  const fixture = await bridge(t);
  const socket = await fixture.connect();
  const messages = [];
  socket.on("message", (bytes) => messages.push(JSON.parse(bytes)));
  const threadId = "retry-thread";
  const turnId = "retry-turn";
  const retry = {
    threadId,
    turnId,
    willRetry: true,
    error: {
      message: "Reconnecting... waiting for network",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    },
  };
  const statusOf = (connection) =>
    connection.initialState.executionStatuses[threadId];
  const statusMessages = () =>
    messages.filter((message) => message.method === "lan/executionStatus");
  fixture.notify("turn/started", {
    threadId,
    turn: { id: turnId, status: "inProgress" },
  });
  fixture.notify("error", retry);
  await waitFor(() => statusMessages().length === 1);
  assert.deepEqual(statusMessages()[0].params, {
    threadId,
    turnId,
    kind: "retrying",
    message: retry.error.message,
  });
  assert(!messages.some((message) => message.method === "error"));

  fixture.notify("error", { ...retry, turnId: "old-turn" });
  fixture.notify("item/started", {
    threadId,
    turnId,
    item: { type: "userMessage" },
  });
  fixture.notify("item/completed", {
    threadId,
    turnId,
    item: { type: "commandExecution" },
  });
  fixture.notify("item/agentMessage/delta", {
    threadId: "other-thread",
    turnId,
  });
  fixture.notify("item/reasoning/summaryTextDelta", {
    threadId,
    turnId: "old-turn",
  });
  assert.equal(statusOf(await fixture.connect()).kind, "retrying");
  assert.equal(statusMessages().length, 1);

  fixture.notify("item/agentMessage/delta", { threadId, turnId });
  await waitFor(() => statusMessages().length === 2);
  assert.deepEqual(statusMessages()[1].params, {
    threadId,
    turnId,
    kind: "working",
  });
  assert.equal(statusOf(await fixture.connect()), undefined);

  fixture.notify("error", retry);
  fixture.notify("item/started", {
    threadId,
    turnId,
    item: { type: "commandExecution" },
  });
  assert.equal(statusOf(await fixture.connect()), undefined);

  fixture.notify("error", retry);
  fixture.notify("turn/completed", {
    threadId,
    turn: { id: "old-turn", status: "completed" },
  });
  assert.equal(statusOf(await fixture.connect()).kind, "retrying");
  fixture.notify("turn/completed", {
    threadId,
    turn: { id: turnId, status: "completed" },
  });
  assert.equal(statusOf(await fixture.connect()), undefined);

  const failedTurnId = "failed-turn";
  fixture.notify("turn/started", {
    threadId,
    turn: { id: failedTurnId, status: "inProgress" },
  });
  fixture.notify("error", { ...retry, turnId: failedTurnId });
  const failure = {
    ...retry,
    turnId: failedTurnId,
    willRetry: false,
    error: { message: "模型请求失败" },
  };
  fixture.notify("error", failure);
  assert.deepEqual(
    (
      await waitFor(() =>
        messages.find((message) => message.method === "error"),
      )
    ).params,
    failure,
  );
  assert.equal(statusOf(await fixture.connect()), undefined);
});
