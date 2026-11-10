import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import React, { act } from "react";
import { create } from "react-test-renderer";

export async function testHistoryTranslations(app) {
  const original = app.get();
  const originalFetch = globalThis.fetch;
  const requests = [];
  let view;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/translate");
    const { texts } = JSON.parse(options.body);
    requests.push(...texts);
    return Response.json({
      translations: texts.map((text) =>
        text
          .replace(/Stored heading (\d+)/g, "历史标题 $1")
          .replace(/Stored body (\d+)/g, "历史正文 $1"),
      ),
    });
  };
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `history-${index}`,
    type: "reasoning",
    turnId: "history-turn",
    summary: [`Stored heading ${index}\nStored body ${index}`],
  }));
  try {
    app.set({
      current: { id: "translation-history" },
      loading: false,
      active: {},
      questions: [],
      items,
      translation: {
        enabled: true,
        state: "ready",
        model: { id: "edge-en-zh", version: "history" },
      },
    });
    await act(async () => {
      view = create(React.createElement(app.Conversation));
    });
    await act(async () =>
      view.root
        .findByProps({ className: "process-history" })
        .props.onToggle({ currentTarget: { open: true } }),
    );
    await act(async () => delay(300));
    for (let index = 0; index < 12; index++)
      assert.ok(JSON.stringify(view.toJSON()).includes(`历史正文 ${index}`));
    const count = requests.length;
    await act(async () => view.unmount());
    await act(async () => {
      view = create(React.createElement(app.Conversation));
    });
    await act(async () =>
      view.root
        .findByProps({ className: "process-history" })
        .props.onToggle({ currentTarget: { open: true } }),
    );
    await act(async () => delay(150));
    assert.equal(requests.length, count, "历史消息重新挂载复用当前模型的译文");
  } finally {
    if (view) await act(async () => view.unmount());
    globalThis.fetch = originalFetch;
    app.set(original);
  }
  console.log("PASS 完整历史消息翻译与当前模型的译文缓存复用");
}
