import assert from "node:assert/strict";
import React, { act } from "react";
import { create } from "react-test-renderer";
import { setTimeout as delay } from "node:timers/promises";

export async function testMermaid(app) {
  const theme = app.get().theme;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const containers = new Set();
  const mediaListeners = new Set();
  const media = {
    matches: false,
    addEventListener: (_, listener) => mediaListeners.add(listener),
    removeEventListener: (_, listener) => mediaListeners.delete(listener),
  };
  let copied;
  globalThis.testMermaidCalls = [];
  globalThis.matchMedia = () => media;
  globalThis.document = {
    body: { append: (element) => containers.add(element) },
    createElement: () => ({
      remove() {
        containers.delete(this);
      },
    }),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text) => (copied = text) } },
  });
  const source = "flowchart LR\n  A[输入] --> B[输出]\n";
  const markdown = (code) => "```mermaid\n" + code + "```";
  const calls = globalThis.testMermaidCalls;
  const waitForRender = () => act(async () => delay(300));
  const complete = (call) =>
    act(async () => call.resolve({ svg: `<svg id="${call.id}"></svg>` }));
  let view;
  const update = (text) =>
    act(async () => view.update(React.createElement(app.RichText, { text })));
  try {
    app.set({ theme: "light" });
    await act(async () => {
      view = create(
        React.createElement(app.RichText, {
          text:
            markdown(source) +
            "\n\n```js\nconst n = 1;\n```\n\n行内 `mermaid` 与 $x^2$。",
        }),
      );
    });
    assert.equal(calls.length, 0);
    await waitForRender();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, source);
    assert.equal(calls[0].config.securityLevel, "strict");
    assert.equal(calls[0].config.startOnLoad, false);
    assert.equal(calls[0].config.suppressErrorRendering, true);
    assert.equal(calls[0].config.theme, "default");
    await complete(calls[0]);
    assert.equal(containers.size, 0);
    assert(view.root.findByProps({ "aria-label": "Mermaid 图表" }));
    await act(async () =>
      view.root.findByProps({ "aria-expanded": false }).props.onClick(),
    );
    assert(view.root.findByProps({ "aria-expanded": true }));
    assert(view.root.findByProps({ className: "mermaid-diagram is-expanded" }));
    assert(view.root.findByProps({ className: "hljs-keyword" }));
    assert(view.root.findAllByType("math").length > 0);
    await act(async () =>
      view.root.findByProps({ title: "复制图表源码" }).props.onClick(),
    );
    assert.equal(copied, source);
    const toggle = () => view.root.findByProps({ "aria-pressed": false });
    await act(async () => toggle().props.onClick());
    assert.equal(
      view.root.findAllByProps({ "aria-label": "Mermaid 图表" }).length,
      0,
    );
    assert(
      view.root
        .findAllByType("code")
        .some((node) => node.props.children === source),
    );
    await update(markdown(source) + "\n\n回复继续更新。");
    await waitForRender();
    assert.equal(calls.length, 1);
    assert(view.root.findByProps({ "aria-pressed": true }));
    await act(async () =>
      view.root.findByProps({ "aria-pressed": true }).props.onClick(),
    );
    assert(view.root.findByProps({ "aria-expanded": true }));
    await act(async () =>
      view.root.findByProps({ "aria-expanded": true }).props.onClick(),
    );
    assert(view.root.findByProps({ "aria-expanded": false }));

    await update(markdown("flowchart LR\n  A[\n"));
    await waitForRender();
    assert.equal(calls.length, 2);
    const latest = "flowchart LR\n  A[完成] --> C[新结果]\n";
    await update(markdown(latest));
    await act(async () => calls[1].reject(new Error("尚未完整")));
    await waitForRender();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].source, latest);
    assert(!JSON.stringify(view.toJSON()).includes("语法错误"));
    await complete(calls[2]);
    assert(view.root.findByProps({ "aria-label": "Mermaid 图表" }));

    await update(markdown("无效图表\n"));
    await waitForRender();
    await act(async () => calls[3].reject(new Error("语法错误")));
    assert(JSON.stringify(view.toJSON()).includes("语法错误"));
    assert.equal(view.root.findByType("code").props.children, "无效图表\n");
    assert.equal(containers.size, 0);

    await update(markdown(source) + "\n\n" + markdown(latest));
    await waitForRender();
    assert.equal(calls.length, 5);
    await complete(calls[4]);
    assert.equal(calls.length, 6);
    await complete(calls[5]);
    assert.equal(
      view.root.findAllByProps({ "aria-label": "Mermaid 图表" }).length,
      2,
    );
    assert.equal(new Set(calls.map((call) => call.id)).size, calls.length);

    await act(async () => app.set({ theme: "dark" }));
    await waitForRender();
    assert.equal(calls[6].config.theme, "dark");
    await complete(calls[6]);
    await complete(calls[7]);
    await act(async () => app.set({ theme: "system" }));
    await waitForRender();
    await complete(calls[8]);
    await complete(calls[9]);
    await act(async () => {
      media.matches = true;
      for (const listener of mediaListeners) listener();
    });
    await waitForRender();
    assert.equal(calls[10].config.theme, "dark");
    await complete(calls[10]);
    await complete(calls[11]);

    await update(markdown("flowchart TD\n  X --> Y\n"));
    await waitForRender();
    await act(async () => view.unmount());
    await complete(calls[12]);
    assert.equal(containers.size, 0);
    assert.equal(mediaListeners.size, 0);
    console.log(
      "PASS Mermaid 图表、源码复制与切换、流式更新、失败恢复、多图串行、主题和卸载清理",
    );
  } finally {
    await act(async () => view?.unmount());
    app.set({ theme });
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    delete globalThis.document;
    delete globalThis.matchMedia;
    delete globalThis.testMermaidCalls;
  }
}
