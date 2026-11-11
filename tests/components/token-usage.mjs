import assert from "node:assert/strict";
import React, { act } from "react";
import { create } from "react-test-renderer";

export async function testTokenUsage(app, fixture) {
  const original = app.get();
  const thread = { id: "usage-history", cwd: "/fixture/usage" };
  const usage = (totalTokens) => ({
    last: { totalTokens },
    modelContextWindow: 475000,
  });
  let raceMethod;
  let view;
  fixture.responseFor = async ({ method, params }) => {
    if (["thread/read", "thread/resume"].includes(method)) {
      if (method === "thread/read") assert.equal(params.includeTurns, false);
      if (method === "thread/resume") assert.equal(params.excludeTurns, true);
      if (raceMethod === method)
        await fixture.socket.emit("thread/tokenUsage/updated", {
          threadId: thread.id,
          tokenUsage: usage(200000),
        });
      return { thread: { ...thread, tokenUsage: usage(118863) } };
    }
    return { data: [], nextCursor: null };
  };
  try {
    app.set({ connected: true, tokenUsage: {}, active: {} });
    await act(async () => {
      view = create(React.createElement(app.Composer));
      await app.openThread(thread.id);
    });
    assert.equal(app.get().tokenUsage[thread.id].last.totalTokens, 118863);
    assert(JSON.stringify(view.toJSON()).includes("118,863"));
    assert(JSON.stringify(view.toJSON()).includes("475,000"));

    await act(async () => {
      app.set({ tokenUsage: {} });
      await app.refreshThreadAccess({ background: true });
    });
    assert.equal(app.get().tokenUsage[thread.id].last.totalTokens, 118863);

    raceMethod = "thread/read";
    await act(async () => {
      app.set({ tokenUsage: {} });
      await app.openThread(thread.id);
    });
    assert.equal(app.get().tokenUsage[thread.id].last.totalTokens, 200000);

    raceMethod = "thread/resume";
    await act(async () => {
      await app.refreshThreadAccess({ background: true });
    });
    assert.equal(app.get().tokenUsage[thread.id].last.totalTokens, 200000);
  } finally {
    await act(async () => {
      view?.unmount();
      app.set(original);
    });
    localStorage.removeItem("cx-draft-" + thread.id);
  }
  console.log("PASS 轻量历史及重连恢复上下文用量，实时统计优先于迟到历史");
}
