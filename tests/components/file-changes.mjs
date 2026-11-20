import assert from "node:assert/strict";
import React, { act } from "react";
import { create } from "react-test-renderer";

export async function testFileChanges(app, requests, setResponse, emit) {
  const original = app.get();
  const threadId = "file-changes-fixture";
  const cwd = "/file-changes-fixture";
  const diff =
    "--- a/main.js\n+++ b/main.js\n@@ -1 +1,2 @@\n-old\n+new\n+added\n";
  const file = (id, turnId, path = "main.js", status = "completed") => ({
    id,
    turnId,
    type: "fileChange",
    status,
    changes: [{ path, kind: { type: "update" }, diff }],
  });
  const answer = (id, turnId) => ({
    id,
    turnId,
    type: "agentMessage",
    phase: "final_answer",
    text: "修改完成。",
  });
  let failure = true;
  setResponse(({ method }) => {
    if (method === "lan/files/undo")
      return failure ? { error: { message: "文件已有后续修改" } } : {};
    if (method === "thread/list") return { data: [], nextCursor: null };
    return {};
  });
  let view;
  const rows = () =>
    view.root.findAllByProps({ className: "file-change-item" });
  const undo = () =>
    rows()[0]
      .findAllByType("button")
      .find((b) => b.props.className === "file-change-undo");
  try {
    app.set({
      connected: true,
      current: { id: threadId, cwd },
      cwd,
      loading: false,
      items: [
        file("first-edit", "first"),
        answer("first-answer", "first"),
        file("second-edit", "second"),
        file("failed-edit", "second", "failed.js", "failed"),
        answer("second-answer", "second"),
      ],
      turns: {
        [threadId]: [
          { id: "first", status: "completed" },
          { id: "second", status: "inProgress" },
        ],
      },
      active: { [threadId]: "second" },
      turnDiffs: {},
      undoneFiles: {},
      questions: [],
      plans: {},
    });
    await act(async () => {
      view = create(React.createElement(app.Conversation));
    });
    assert.equal(rows().length, 1);
    const resultOrder = () =>
      view.root
        .findAll(
          (node) =>
            typeof node.type === "string" &&
            ["本轮文件变更", "回复操作"].includes(node.props["aria-label"]),
        )
        .map((node) => node.props["aria-label"]);
    assert.deepEqual(resultOrder(), ["本轮文件变更", "回复操作"]);
    assert.equal(undo().props.disabled, true);
    assert.equal(
      rows()[0].findByProps({ className: "file-change-added" }).props
        .children[1],
      2,
    );
    await act(async () =>
      emit("turn/diff/updated", {
        threadId,
        turnId: "second",
        diff:
          "diff --git a/second.js b/second.js\n" +
          diff.replaceAll("main.js", "second.js"),
      }),
    );
    await act(async () =>
      emit("turn/completed", {
        threadId,
        turn: { id: "second", status: "completed", completedAt: 123 },
      }),
    );
    assert.equal(rows().length, 2);
    assert.deepEqual(resultOrder(), [
      "本轮文件变更",
      "回复操作",
      "本轮文件变更",
      "回复操作",
    ]);
    assert.equal(
      rows()[1].findByProps({ className: "file-change-name" }).props.title,
      cwd + "/second.js",
    );
    assert.equal(
      rows()[0].findByProps({ className: "file-change-name" }).props.title,
      cwd + "/main.js",
    );
    await act(async () =>
      rows()[0].findByProps({ className: "file-change-view" }).props.onClick(),
    );
    assert.equal(app.get().panel, "files");
    assert.equal(app.get().panelFile.path, cwd + "/main.js");
    assert.equal(app.get().panelFile.diff, diff);
    assert.equal(app.get().panelFile.kind, "full");
    assert.deepEqual(app.get().panelFile.patches, [diff]);
    await act(async () =>
      rows()[0]
        .findByProps({ className: "file-change-source" })
        .props.onClick(),
    );
    assert.deepEqual(app.get().panelFile, {
      kind: "file",
      path: cwd + "/main.js",
    });
    assert.equal(
      rows()[0].findAllByProps({ className: "diff-block" }).length,
      0,
    );
    await act(async () =>
      rows()[0].findByProps({ className: "file-change-name" }).props.onClick(),
    );
    assert.equal(app.get().panelFile.path, cwd + "/main.js");
    assert.equal(app.get().panelFile.kind, "diff");
    await act(async () => undo().props.onClick());
    assert.equal(
      rows()[0].findByProps({ role: "alert" }).props.children,
      "文件已有后续修改",
    );
    assert.equal(undo().props.disabled, false);
    failure = false;
    await act(async () => undo().props.onClick());
    const request = requests.findLast((r) => r.method === "lan/files/undo");
    assert.deepEqual(request.params, {
      threadId,
      turnId: "first",
      path: cwd + "/main.js",
    });
    await act(async () => emit("lan/files/undone", request.params));
    assert.equal(undo().props.disabled, true);
    assert.equal(
      rows()[0].findByProps({ className: "file-change-undone" }).props.children,
      "已撤销",
    );
    await act(async () => app.set({ undoneFiles: {} }));
    await act(async () =>
      emit("lan/state", {
        ready: true,
        defaultCwd: cwd,
        activeTurns: {},
        questions: [],
        undoneFiles: [request.params],
      }),
    );
    assert.equal(undo().props.disabled, true);
    await act(async () => view.unmount());
    await act(async () => {
      view = create(React.createElement(app.Conversation));
    });
    assert.equal(rows().length, 2);
    assert.equal(undo().props.disabled, true);
    await act(async () =>
      app.set({ current: { id: "other", cwd }, items: [] }),
    );
    assert.equal(rows().length, 0);
    await act(async () =>
      app.set({
        current: { id: threadId, cwd },
        active: {},
        turnDiffs: {},
        items: [
          ...Array.from({ length: 17 }, (_, index) =>
            file(`many-${index}`, "many", `file-${index}.js`),
          ),
          answer("many-answer", "many"),
        ],
      }),
    );
    const heading = () => view.root.findByProps({ "aria-label": "已编辑文件" });
    const more = () =>
      view.root.findByProps({ className: "file-changes-more" });
    const list = () =>
      view.root.findByProps({ "aria-label": "已编辑文件列表" });
    assert.equal(
      view.root.findAllByProps({ "aria-label": "本轮文件变更" }).length,
      1,
    );
    assert.equal(heading().findByType("small").props.children, 17);
    assert.equal(rows().length, 5);
    assert.deepEqual(resultOrder(), ["本轮文件变更", "回复操作"]);
    assert.equal(more().props.children[0], "显示其余 12 个文件");
    assert.equal(
      rows()[0]
        .findByProps({ className: "file-change-name" })
        .findByType("span").props.children,
      "file-0.js",
    );
    await act(async () => more().props.onClick());
    assert.equal(rows().length, 17);
    await act(async () =>
      rows()[8].findByProps({ className: "file-change-view" }).props.onClick(),
    );
    assert.equal(
      rows()[8].findAllByProps({ className: "diff-block" }).length,
      0,
    );
    assert.equal(app.get().panelFile.path, cwd + "/file-8.js");
    await act(async () => heading().props.onClick());
    assert.equal(list().props.hidden, true);
    assert.equal(heading().props["aria-expanded"], false);
    await act(async () => heading().props.onClick());
    assert.equal(list().props.hidden, false);
    assert.equal(
      rows()[8].findAllByProps({ className: "diff-block" }).length,
      0,
    );
    assert.equal(app.get().panelFile.path, cwd + "/file-8.js");
    await act(async () => more().props.onClick());
    assert.equal(rows().length, 5);
    await act(async () =>
      app.set({ items: [answer("plain-answer", "plain")] }),
    );
    assert.equal(rows().length, 0);
    assert.deepEqual(resultOrder(), ["回复操作"]);
    console.log(
      "PASS 文件汇总紧凑列表、17 文件默认显示 5 项与展开收起、历史恢复、轮次隔离、差异在右侧文件面板查看、撤销冲突与通知同步",
    );
  } finally {
    if (view) await act(async () => view.unmount());
    app.set(original);
  }
}
