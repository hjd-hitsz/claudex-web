import test from "node:test";
import assert from "node:assert/strict";
import { bridge, waitFor } from "../../tests/helpers/bridge.mjs";
import { createResumeLifecycle } from "../src/backends/codex/resume-lifecycle.mjs";
import { createRequestHandler } from "../src/backends/codex/requests.mjs";

const closingError = (threadId) => ({
  code: -32600,
  message: `thread ${threadId} is closing; retry thread/resume after the thread is closed`,
});

for (const earlyClose of [false, true]) {
  test(`原生关闭${earlyClose ? "先于" : "晚于"}恢复错误时，同一次网页请求自动恢复`, async (t) => {
    let attempted = false;
    const app = await bridge(t, (request, socket) => {
      if (request.method !== "thread/resume" || attempted) return false;
      attempted = true;
      if (earlyClose)
        socket.send(
          JSON.stringify({
            method: "thread/closed",
            params: { threadId: "reopen" },
          }),
        );
      socket.send(
        JSON.stringify({ id: request.id, error: closingError("reopen") }),
      );
      return true;
    });
    const client = await app.connect();
    const result = app.rpc(client, "thread/resume", {
      threadId: "reopen",
      excludeTurns: true,
    });
    await waitFor(() => app.requests.some((r) => r.method === "thread/resume"));
    if (!earlyClose) {
      app.notify("thread/closed", { threadId: "other" });
      await app.rpc(client, "test/barrier");
      assert.equal(
        app.requests.filter((r) => r.method === "thread/resume").length,
        1,
      );
      app.notify("thread/closed", { threadId: "reopen" });
    }
    assert.equal((await result).thread.id, "reopen");
    const resumes = app.requests.filter((r) => r.method === "thread/resume");
    assert.equal(resumes.length, 2);
    assert.deepEqual(resumes[1], resumes[0]);
  });
}

test("并发发送等待原生关闭，共用一次恢复且每个轮次只提交一次", async (t) => {
  let attempted = false;
  const app = await bridge(t, (request, socket) => {
    if (request.method !== "thread/resume" || attempted) return false;
    attempted = true;
    socket.send(
      JSON.stringify({ id: request.id, error: closingError("write") }),
    );
    return true;
  });
  const first = await app.connect();
  const second = await app.connect();
  const writes = [first, second].map((client) =>
    app.rpc(client, "turn/start", { threadId: "write", input: [] }),
  );
  await waitFor(() => app.requests.some((r) => r.method === "thread/resume"));
  await app.rpc(first, "test/barrier");
  await app.rpc(second, "test/barrier");
  assert.equal(
    app.requests.some((r) => r.method === "turn/start"),
    false,
  );
  app.notify("thread/closed", { threadId: "write" });
  await Promise.all(writes);
  assert.equal(
    app.requests.filter((r) => r.method === "thread/resume").length,
    2,
  );
  assert.equal(app.requests.filter((r) => r.method === "turn/start").length, 2);
});

test("等待关闭时断线结算原请求，重连后可重新打开", async (t) => {
  let attempted = false;
  const app = await bridge(t, (request, socket) => {
    if (request.method !== "thread/resume" || attempted) return false;
    attempted = true;
    socket.send(
      JSON.stringify({ id: request.id, error: closingError("offline") }),
    );
    return true;
  });
  const client = await app.connect();
  const failed = assert.rejects(
    app.rpc(client, "thread/resume", { threadId: "offline" }),
    /连接中断/,
  );
  await waitFor(() => app.requests.some((r) => r.method === "thread/resume"));
  await app.rpc(client, "test/barrier");
  app.disconnect();
  await failed;
  const recovered = await app.connect();
  app.notify("thread/closed", { threadId: "offline" });
  await app.rpc(recovered, "test/barrier");
  assert.equal(
    app.requests.filter((r) => r.method === "thread/resume").length,
    1,
  );
  assert.equal(
    (await app.rpc(recovered, "thread/resume", { threadId: "offline" })).thread
      .id,
    "offline",
  );
});

test("仅目标线程的原生关闭错误允许一次恢复，其他错误直接返回", () => {
  const pending = new Map();
  const sent = [];
  const lifecycle = createResumeLifecycle({
    pending,
    send: (m) => sent.push(m),
  });
  const request = {
    method: "thread/resume",
    resumeParams: { threadId: "target" },
  };
  pending.set(1, request);
  for (const error of [
    closingError("other"),
    { ...closingError("target"), code: -32000 },
    { code: -32600, message: "thread target already has an active writer" },
  ])
    assert.equal(lifecycle.defer(1, request, error), false);
  assert.equal(lifecycle.defer(1, request, closingError("target")), true);
  assert.equal(sent.length, 0);
  lifecycle.closed("other");
  assert.equal(sent.length, 0);
  lifecycle.closed("target");
  assert.equal(sent.length, 1);
  assert.equal(lifecycle.defer(1, request, closingError("target")), false);
  lifecycle.closed("target");
  assert.equal(sent.length, 1);
});

test("等待关闭沿用网页请求期限，超时后迟到关闭事件保持请求已结束", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = new Map();
  const responses = [];
  const sent = [];
  const transport = {
    ready: true,
    pending,
    nextId: () => 1,
    sendText: (m) => sent.push(JSON.parse(m)),
  };
  const handle = createRequestHandler({
    transport,
    compactions: { busy: () => false },
    undoing: new Set(),
    activeTurns: new Map(),
    activeThreads: new Set(),
    releasing: new Map(),
    offline: new Map(),
    online: new Map(),
    releaseUnusedThreads() {},
    send: (client, m) => responses.push(m),
  });
  await handle(
    {},
    { id: 77, method: "thread/resume", params: { threadId: "timeout" } },
  );
  const lifecycle = createResumeLifecycle({
    pending,
    send: (m) => sent.push(m),
  });
  assert.equal(
    lifecycle.defer(1, pending.get(1), closingError("timeout")),
    true,
  );
  t.mock.timers.tick(119999);
  assert.equal(responses.length, 0);
  t.mock.timers.tick(1);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 77);
  assert.match(responses[0].error.message, /超时/);
  assert.equal(pending.size, 0);
  lifecycle.closed("timeout");
  assert.equal(sent.length, 1);
});
