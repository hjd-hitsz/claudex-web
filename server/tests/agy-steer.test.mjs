import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyAcpUpdate } from "../src/backends/agy/acp-events.mjs";
import { createAgyTurns } from "../src/backends/agy/acp-turns.mjs";
import { createAgyCompactions } from "../src/backends/agy/compactions.mjs";
import { createAgyStore } from "../src/backends/agy/session-store.mjs";

const blocks = (text) => [{ type: "text", text }];
const user = (id) => ({ id, type: "userMessage", content: blocks(id) });
const completed = { stopReason: "end_turn" };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "agy-steer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = new Map();
  const events = [];
  const calls = [];
  const notifications = [];
  const started = Promise.withResolvers();
  const store = createAgyStore(directory);
  const session = { id: "web-session", cwd: directory, turns: [] };
  await store.change((data) => (data.sessions[session.id] = session));
  const entry = {
    nativeId: "native-session",
    config: {},
    client: {
      call(method, params) {
        assert.equal(method, "session/prompt");
        const reply = Promise.withResolvers();
        calls.push({ params, ...reply });
        started.resolve();
        return reply.promise;
      },
      notify(method, params) {
        notifications.push({ method, params });
      },
    },
  };
  const compactions = createAgyCompactions(() => null);
  const notify = (method, params) =>
    events.push(structuredClone({ method, params }));
  const turns = createAgyTurns({
    active,
    entries: new Map([[session.id, entry]]),
    compactions,
    store,
    execution: { forwardingContext: (_id, prompt) => prompt },
    emit: ({ method, params }) => notify(method, params),
    readRole: () => "",
    prepareSession: () => ({ entry }),
    agentInfo: () => ({}),
    idle: () => {},
  });
  const current = () => active.get(session.id);
  const readTurn = async () =>
    (await store.read()).sessions[session.id].turns[0];
  const steer = (id = "补充", expected = "web-turn") =>
    turns.steer(session, expected, user(id), {}, blocks(id));
  const append = (text) =>
    applyAcpUpdate(
      current(),
      { sessionUpdate: "agent_message_chunk", content: blocks(text)[0] },
      notify,
    );
  const run = turns.prompt(
    session,
    { id: "web-turn", items: [user("原任务")] },
    {},
    blocks("原任务"),
  );
  await started.promise;
  return {
    turns,
    session,
    compactions,
    events,
    calls,
    notifications,
    current,
    readTurn,
    steer,
    append,
    run,
  };
}

test("agy 补充说明复用原生会话与网页轮次，旧请求回执后继续合并输出", async (t) => {
  const f = await fixture(t);
  f.append("已有正文");
  assert.deepEqual(await f.steer(), { turnId: "web-turn" });
  const saved = await f.readTurn();
  assert.deepEqual(
    saved.items.map(({ text, content }) => text || content[0].text),
    ["原任务", "已有正文", "补充"],
  );
  f.calls[0].resolve(completed);
  await Promise.resolve();
  assert.equal(f.current()?.turn.id, "web-turn");
  await f.steer("再次补充");
  f.calls[1].resolve(completed);
  await Promise.resolve();
  f.append("继续生成");
  f.calls[2].resolve(completed);
  const { turn } = await f.run;
  assert.equal(turn.status, "completed");
  assert.deepEqual(
    turn.items
      .filter(({ type }) => type === "agentMessage")
      .map(({ text }) => text),
    ["已有正文继续生成"],
  );
  assert(f.calls.every(({ params }) => params.sessionId === "native-session"));
  assert.deepEqual(f.notifications, []);
  assert.equal(
    f.events.filter(({ method }) => method === "turn/started").length,
    1,
  );
  assert.equal(
    f.events.filter(({ method }) => method === "turn/completed").length,
    1,
  );
  for (const id of ["补充", "再次补充"])
    assert.equal(
      f.events.filter(({ params }) => params.item?.id === id).length,
      1,
    );
  assert.equal(f.current(), undefined);
});

test("agy 拒绝过期轮次及整理期间的补充，并允许取消仍在执行的原生请求", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.steer("补充", "old-turn"),
    /轮次已结束或发生变化.*仍在输入框/,
  );
  f.compactions.entries.set(f.session.id, { status: "running" });
  await assert.rejects(f.steer(), /正在整理上下文/);
  assert.equal(f.calls.length, 1);
  f.compactions.entries.clear();
  f.append("原任务的部分输出");
  await f.steer();
  f.calls[0].resolve(completed);
  f.turns.cancelActive(f.session.id);
  f.turns.cancelActive(f.session.id);
  f.calls[1].resolve({ stopReason: "cancelled" });
  assert.deepEqual(f.notifications, [
    {
      method: "session/cancel",
      params: { sessionId: "native-session" },
    },
  ]);
  assert.equal((await f.run).turn.status, "interrupted");
  assert.equal((await f.readTurn()).items.length, 3);
  assert.equal(f.current(), undefined);
});

test("agy 补充请求失败或断线后保留已生成正文并结算轮次", async (t) => {
  const f = await fixture(t);
  f.append("保留输出");
  await f.steer();
  f.calls[1].reject(new Error("ACP 连接关闭"));
  f.calls[0].reject(new Error("ACP 连接关闭"));
  const { turn } = await f.run;
  assert.equal(turn.status, "failed");
  assert.equal(turn.error.message, "ACP 连接关闭");
  assert.match(
    f.events.find(({ method }) => method === "error")?.params.error.message,
    /补充说明发送失败/,
  );
  assert.deepEqual(
    (await f.readTurn()).items.map(
      ({ text, content }) => text || content[0].text,
    ),
    ["原任务", "保留输出", "补充"],
  );
  assert.equal(f.current(), undefined);
});
