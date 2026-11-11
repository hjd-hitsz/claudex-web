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
      active: { "translation-history": "history-turn" },
      questions: [],
      items: [
        ...items,
        {
          id: "streaming",
          type: "reasoning",
          turnId: "history-turn",
          status: "inProgress",
          summary: ["Still generating"],
        },
      ],
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
    assert.ok(
      !requests.includes("Still generating"),
      "正在生成的消息等待完成事件",
    );
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
    await act(async () => view.unmount());
    await act(async () => {
      view = create(
        React.createElement(app.ReadOnlyConversation, {
          items: [
            ...items,
            {
              id: "tool",
              type: "commandExecution",
              turnId: "history-turn",
              command: "pwd",
              status: "running",
            },
          ],
          turns: [{ id: "history-turn", status: "inProgress" }],
        }),
      );
    });
    await act(async () =>
      view.root
        .findByProps({ className: "process-history" })
        .props.onToggle({ currentTarget: { open: true } }),
    );
    for (let index = 0; index < 12; index++)
      assert.ok(JSON.stringify(view.toJSON()).includes(`历史正文 ${index}`));
  } finally {
    if (view) await act(async () => view.unmount());
    globalThis.fetch = originalFetch;
    app.set(original);
  }
  console.log(
    "PASS 运行中会话与子代理历史摘要翻译、当前流式消息等待及译文缓存复用",
  );
}
