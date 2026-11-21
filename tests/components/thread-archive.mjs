import assert from "node:assert/strict";
import React, { act } from "react";
import { create } from "react-test-renderer";

export async function testThreadArchive(app, requests, setResponse, emit) {
  const original = app.get();
  const threads = [
    { id: "archived-fixture", cwd: "/archive-test", createdAt: 2 },
    { id: "remaining-fixture", cwd: "/remaining-test", createdAt: 1 },
  ];
  const [thread, other] = threads;
  const archived = new Set();
  const savedDraft = localStorage.getItem("cx-draft-new");
  const projectOrder = ["", thread.cwd, other.cwd];
  const archivedError = {
    message: `session ${thread.id} is archived. Run 'codex unarchive ${thread.id}' to unarchive it first.`,
  };
  let failMethod;
  let holdMethod;
  let holdId;
  let finish;
  let archiveNextPage;
  let finishArchivePage;
  let view;
  const start = requests.length;
  const readThread = (t) => ({
    ...t,
    path: archived.has(t.id) ? "/fixture/archived_sessions/chat.jsonl" : "",
  });
  setResponse(({ method, params }) => {
    if (method === holdMethod && params.threadId === holdId) {
      holdMethod = null;
      return new Promise((resolve) => (finish = resolve));
    }
    if (method === failMethod && params.threadId === thread.id) {
      archived.add(thread.id);
      return { error: archivedError };
    }
    if (method === "thread/list") {
      if (params.archived && params.cursor === "archive-page-two")
        return new Promise((resolve) => (finishArchivePage = resolve));
      return {
        data: threads
          .filter((t) => archived.has(t.id) === params.archived)
          .map(readThread),
        nextCursor:
          params.archived && archiveNextPage ? "archive-page-two" : null,
      };
    }
    if (method === "lan/projectless/read") return { directories: {} };
    if (method === "thread/read" || method === "thread/resume")
      return {
        thread: readThread(threads.find((t) => t.id === params.threadId)),
      };
    if (method === "thread/unarchive") archived.delete(params.threadId);
    return { data: [] };
  });
  const reset = async () => {
    archived.clear();
    failMethod = null;
    holdMethod = null;
    finish = null;
    app.newChat(thread.cwd);
    app.set({
      connected: true,
      archived: false,
      search: "",
      threads,
      projectOrder,
      active: {},
      questions: [],
      modal: null,
    });
    localStorage.setItem("cx-draft-" + thread.id, "归档聊天的未发送草稿");
    await app.loadThreads();
  };
  const assertArchived = () => {
    assert.equal(app.get().current, null);
    assert.equal(app.get().threadAccess, null);
    assert.equal(app.get().loading, false);
    assert.equal(app.get().error, "");
    assert.deepEqual(
      app.get().threads.map((t) => t.id),
      [other.id],
    );
    assert.deepEqual(app.get().projectOrder, projectOrder);
    assert.equal(localStorage.getItem("cx-current"), null);
    assert.equal(
      localStorage.getItem("cx-draft-" + thread.id),
      "归档聊天的未发送草稿",
    );
    assert.equal(
      view.root.findAllByProps({ "aria-label": "重试连接对话" }).length,
      0,
    );
    assert.equal(view.root.findAllByProps({ "aria-label": "消息" }).length, 1);
    assert(!JSON.stringify(view.toJSON()).includes("is archived"));
  };
  try {
    await act(async () => {
      await reset();
      view = create(React.createElement(app.Composer));
    });
    for (const method of [
      "thread/read",
      "thread/items/list",
      "thread/resume",
      "turn/start",
      "thread/compact/start",
      "review/start",
    ]) {
      await act(async () => {
        await reset();
        if (
          ["turn/start", "thread/compact/start", "review/start"].includes(
            method,
          )
        )
          await app.openThread(thread.id);
        failMethod = method;
        if (method === "turn/start")
          assert.equal(await app.sendMessage(), false);
        else if (method === "thread/compact/start")
          await app.compact().catch(app.report);
        else if (method === "review/start")
          await app.review().catch(app.report);
        else await app.openThread(thread.id);
      });
      assertArchived();
      assert.equal(app.get().items.filter((item) => item.optimistic).length, 0);
    }

    // 已归档响应仅同步本页状态，保留服务端归档结果与本地草稿。
    assert.equal(
      requests
        .slice(start)
        .filter((r) =>
          ["thread/archive", "thread/unarchive"].includes(r.method),
        ).length,
      0,
    );
    let archiveListing;
    const archiveStart = requests.length;
    await act(async () => {
      failMethod = null;
      archiveNextPage = true;
      archiveListing = app.loadThreads({ archived: true });
      assert.equal(app.get().threadListLoading, true);
      assert.deepEqual(app.get().threads, []);
    });
    assert.deepEqual(
      app.get().threads.map((t) => t.id),
      [thread.id],
    );
    assert.equal(app.get().threadListLoading, true);
    assert(finishArchivePage);
    assert(
      requests
        .slice(archiveStart)
        .filter((r) => r.method.startsWith("thread/"))
        .every((r) => r.method === "thread/list"),
    );
    await act(async () => {
      archiveNextPage = false;
      await app.loadThreads({ archived: false });
      finishArchivePage({ data: [readThread(thread)], nextCursor: null });
      await archiveListing;
    });
    assert.deepEqual(
      app.get().threads.map((t) => t.id),
      [other.id],
    );
    assert.equal(app.get().threadListLoading, false);
    await act(async () => app.loadThreads({ archived: true }));
    const openStart = requests.length;
    await act(async () => app.openThread(thread.id));
    assert.equal(app.get().threadAccess.status, "archived");
    assert.equal(app.get().current.id, thread.id);
    assert.equal(
      view.root.findAllByProps({ "aria-label": "恢复对话" }).length,
      1,
    );
    assert(
      requests.slice(openStart).some((r) => r.method === "thread/items/list"),
    );
    assert(
      !requests.slice(openStart).some((r) => r.method === "thread/resume"),
    );
    await act(async () => app.archive(app.get().current));
    assert.equal(app.get().archived, false);
    assert.equal(app.get().current.id, thread.id);
    assert.equal(app.get().draft, "归档聊天的未发送草稿");
    assert.equal(app.get().threadAccess.status, "ready");

    await act(async () => {
      await reset();
      await app.openThread(thread.id);
      app.set({
        active: { [thread.id]: "archived-turn" },
        questions: [
          { id: "archived-question", params: { threadId: thread.id } },
        ],
        modal: { type: "rename", thread },
      });
      archived.add(thread.id);
      await emit("thread/archived", { threadId: thread.id });
    });
    assertArchived();
    assert.deepEqual(app.get().active, {});
    assert.deepEqual(app.get().questions, []);
    assert.equal(app.get().modal, null);
    await act(async () => {
      archived.delete(thread.id);
      await emit("thread/unarchived", { threadId: thread.id });
    });
    assert.deepEqual(
      app.get().threads.map((t) => t.id),
      threads.map((t) => t.id),
    );

    // 旧聊天的归档响应在切换后到达时，只更新对应列表项。
    let stale;
    await act(async () => {
      await reset();
      holdMethod = "thread/resume";
      holdId = thread.id;
      stale = app.openThread(thread.id);
    });
    assert(finish);
    await act(async () => {
      await app.openThread(other.id);
      app.setDraft("当前聊天的草稿");
      archived.add(thread.id);
      finish({ error: archivedError });
      await stale;
    });
    assert.equal(app.get().current.id, other.id);
    assert.equal(app.get().threadAccess.status, "ready");
    assert.equal(app.get().draft, "当前聊天的草稿");
    assert.equal(app.get().error, "");
    assert.deepEqual(
      app.get().threads.map((t) => t.id),
      [other.id],
    );

    // 同一聊天恢复并重新打开后，优先保留较新的检查结果。
    await act(async () => {
      await reset();
      holdMethod = "thread/resume";
      holdId = thread.id;
      stale = app.openThread(thread.id);
    });
    await act(async () => {
      await app.openThread(thread.id);
      finish({ error: archivedError });
      await stale;
    });
    assert.equal(app.get().current.id, thread.id);
    assert.equal(app.get().threadAccess.status, "ready");
    assert.equal(app.get().draft, "归档聊天的未发送草稿");
    assert.equal(app.get().error, "");
    assert.deepEqual(
      app.get().threads.map((t) => t.id),
      threads.map((t) => t.id),
    );

    // 正在打开另一聊天时，归档通知保留这次打开请求。
    await act(async () => {
      await reset();
      await app.openThread(thread.id);
      holdMethod = "thread/read";
      holdId = other.id;
      stale = app.openThread(other.id);
    });
    await act(async () => {
      archived.add(thread.id);
      await emit("thread/archived", { threadId: thread.id });
      finish({ thread: other });
      await stale;
    });
    assert.equal(app.get().current.id, other.id);
    assert.equal(app.get().threadAccess.status, "ready");
    assert.equal(app.get().error, "");

    // 加载中的聊天被归档后，迟到的历史响应保持失效。
    await act(async () => {
      await reset();
      holdMethod = "thread/read";
      holdId = thread.id;
      stale = app.openThread(thread.id);
    });
    await act(async () => {
      archived.add(thread.id);
      await emit("thread/archived", { threadId: thread.id });
      finish({ thread });
      await stale;
    });
    assertArchived();
    console.log(
      "PASS 外部归档错误与通知自动同步、草稿和项目保留、归档恢复及迟到响应隔离",
    );
  } finally {
    await act(async () => {
      view?.unmount();
      app.newChat();
      app.set(original);
    });
    for (const t of threads) localStorage.removeItem("cx-draft-" + t.id);
    if (savedDraft === null) localStorage.removeItem("cx-draft-new");
    else localStorage.setItem("cx-draft-new", savedDraft);
  }
}
