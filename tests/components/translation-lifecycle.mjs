import assert from "node:assert/strict";
import React, { act } from "react";
import { create } from "react-test-renderer";
import { setTimeout as delay } from "node:timers/promises";

export async function testTranslationLifecycle(app) {
  const original = app.get();
  const originalFetch = globalThis.fetch;
  const batches = [];
  let finish;
  let view;
  const ready = {
    enabled: true,
    state: "ready",
    model: { id: "edge-en-zh", version: "lifecycle" },
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/translate");
    const { texts } = JSON.parse(options.body);
    batches.push(texts);
    if (texts.includes("Inspecting application settings and storage"))
      await new Promise((resolve) => {
        finish = resolve;
      });
    return Response.json({
      translations: texts.map((text) =>
        text === "Reviewing local configuration"
          ? "检查本地配置"
          : "检查应用设置与存储",
      ),
    });
  };
  try {
    app.set({
      current: { id: "translation-lifecycle" },
      active: { "translation-lifecycle": "turn" },
      items: [
        {
          id: "thinking",
          type: "reasoning",
          turnId: "turn",
          status: "inProgress",
          summary: [
            "Reviewing local configuration\nInspecting application settings",
          ],
        },
      ],
      translation: { enabled: false, state: "disabled" },
    });
    await act(async () => {
      view = create(React.createElement(app.Conversation));
      await delay(150);
    });
    const visible = () => JSON.stringify(view.toJSON());
    assert.equal(batches.length, 0);
    assert.ok(visible().includes("Reviewing local configuration"));
    await act(async () => {
      app.set({ translation: ready });
      await delay(150);
    });
    assert.equal(batches.length, 0, "流式消息尚未完成时保持零翻译请求");
    await act(async () => {
      app.set({
        items: [
          {
            ...app.get().items[0],
            summary: [
              "Reviewing local configuration\nInspecting application settings and storage",
            ],
          },
        ],
      });
      await delay(400);
    });
    assert.equal(batches.length, 0);
    await act(async () => {
      app.set({ items: [{ ...app.get().items[0], status: "completed" }] });
    });
    await act(async () => delay(180));
    assert.ok(visible().includes("检查本地配置"));
    assert.ok(
      visible().includes("Inspecting application settings and storage"),
      "等待译文时完整原文继续可见",
    );
    assert.ok(!visible().includes("正在翻译摘要"));
    assert.deepEqual(batches.flat(), [
      "Reviewing local configuration",
      "Inspecting application settings and storage",
    ]);
    await act(async () => {
      app.set({ translation: { ...ready, enabled: false } });
      finish();
      await delay(20);
    });
    assert.ok(
      visible().includes("Inspecting application settings and storage"),
    );
    assert.ok(!visible().includes("检查应用设置与存储"));
    await act(async () => {
      app.set({ translation: ready });
      await delay(20);
    });
    assert.ok(visible().includes("检查应用设置与存储"));
    const count = batches.length;
    const toggle = view.root
      .findAllByType("button")
      .find((button) => button.props.className === "translation-original");
    await act(async () => toggle.props.onClick());
    assert.ok(
      visible().includes("Inspecting application settings and storage"),
    );
    assert.equal(batches.length, count);
    await act(async () => toggle.props.onClick());
    assert.ok(visible().includes("检查应用设置与存储"));
  } finally {
    if (view) await act(async () => view.unmount());
    globalThis.fetch = originalFetch;
    app.set(original);
  }
  console.log(
    "PASS 默认原文、完整消息触发翻译、等待时原文可见、关闭隔离迟到响应与原译文切换",
  );
}
