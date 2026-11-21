import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  annotationMessage,
  parseAnnotations,
} from "../../client/src/domain/annotations.js";

const expression = String.raw`D = \sqrt{L_g^2 + L_a^2}`;
const reply = {
  id: "markdown-answer",
  turnId: "source-turn",
  type: "agentMessage",
  phase: "final_answer",
  text: [
    "## 联合距离",
    "对 **加权距离** 使用 `States`，见 [参考](https://example.invalid/metric)，其中 $w_g > 0$。",
    `$$\n${expression}\n$$`,
    "~~~python\nif metric < limit:\n    return metric\n~~~",
    "- [x] 验证条件\n- ~~未加权~~",
    "| 名称 | 数值 |\n| --- | --- |\n| $w_g$ | 2 |",
    "[打开预览](/fixture/annotations/quote.md)",
  ].join("\n\n"),
};

export const annotationMarkdownItems = [reply];

function assertMarkdown(text) {
  assert.match(text, /^## 联合距离\n\n/);
  assert.match(text, /\*\*加权距离\*\*/);
  assert.match(text, /`States`/);
  assert.match(text, /\[参考\]\(https:\/\/example\.invalid\/metric\)/);
  assert.match(text, /\$w_g > 0\$/);
  assert(text.includes(`$$\n${expression}\n$$`), text);
  assert.match(text, /```python\nif metric < limit:\n    return metric\n```/);
  assert.match(text, /- \[x\] 验证条件/);
  assert.match(text, /~~未加权~~/);
  assert.match(text, /\|\s*名称\s*\|\s*数值\s*\|/);
  assert.doesNotMatch(text, /复制代码|复制回复|<math|<span/);
}

export async function verifyAnnotationMarkdown({
  evaluate,
  page,
  waitFor,
  click,
  fill,
  key,
  screenshot,
  output,
  buildInfo,
  setPageZoom,
}) {
  const original = '[data-annotation-message="markdown-answer"] .markdown';
  const quote = ".annotation-card[open] blockquote";
  const select = (selector, position = "") =>
    evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const range = document.createRange();
      range.selectNodeContents(node);
      ${position}
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return { plain: getSelection().toString(), raw: range.toString() };
    })()`);
  const copySelection = async () => {
    await evaluate('navigator.clipboard.writeText("clipboard-fixture")');
    for (const type of ["keyDown", "keyUp"]) {
      await page("Input.dispatchKeyEvent", {
        type,
        key: "c",
        code: "KeyC",
        modifiers: 2,
        ...(type === "keyDown" && { commands: ["copy"] }),
      });
    }
    return evaluate("navigator.clipboard.readText()");
  };

  const legacy = await evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(original)});
    const range = document.createRange();
    range.setStartBefore(root.querySelector("p"));
    const math = root.querySelector(".katex-display");
    if (!math) throw Error([...root.children].map(e => [e.tagName,e.className,e.textContent.slice(0,80)].join(":")).join("\\n"));
    range.setEndAfter(math);
    const before = range.cloneRange();
    before.selectNodeContents(root.parentElement);
    before.setEnd(range.startContainer, range.startOffset);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const startOffset = before.toString().length;
    return {
      text: getSelection().toString(),
      annotation: "请检查联合距离公式。",
      source: {
        messageId: "markdown-answer",
        startOffset,
        endOffset: startOffset + range.toString().length,
      },
    };
  })()`);
  assert(!legacy.text.includes("$$"), legacy.text);
  const history = [
    reply,
    {
      id: "legacy-annotation",
      turnId: "annotation-turn",
      type: "userMessage",
      content: [
        { type: "text", text: annotationMessage([legacy], "请核对。") },
      ],
    },
    {
      id: "legacy-answer",
      turnId: "annotation-turn",
      type: "agentMessage",
      phase: "final_answer",
      text: '已核对。:codex-annotation{index="1"}',
    },
  ];
  await evaluate(`annotationFixture.setHistory(${JSON.stringify(history)})`);
  await page("Page.reload");
  await waitFor("document.querySelector('.annotation-card summary')");
  await click(".annotation-card summary");
  if (process.env.BROWSER_BEFORE === "1") {
    await screenshot("before-broken-annotation");
    await writeFile(
      join(output, "legacy.json"),
      JSON.stringify(legacy, null, 2),
    );
    assert.equal(
      await evaluate(`!!document.querySelector("${quote} .katex")`),
      false,
    );
    return;
  }
  await waitFor(`document.querySelector("${quote} .katex-display")`);
  assert.equal(
    await evaluate(
      `document.querySelector("${quote} .katex-display annotation").textContent`,
    ),
    expression,
  );
  await screenshot("legacy-quote-recovered");
  await select(quote);
  const legacyCopied = await copySelection();
  assert(legacyCopied.includes(`$$\n${expression}\n$$`), legacyCopied);
  await click(".annotation-marker");
  await waitFor("document.querySelector('.annotation-note .katex-display')");
  await select(".annotation-note .markdown");
  assert.equal(await copySelection(), legacyCopied);
  await screenshot("reply-annotation-quote");
  await key("Escape");
  await waitFor(
    "!document.querySelector('.annotation-note') && document.activeElement.matches('.annotation-marker')",
  );

  await select(original);
  assertMarkdown(await copySelection());
  await select(original + " strong", "range.setStart(node.firstChild, 1);");
  assert.equal(await copySelection(), "**权距离**");
  await select(original + " .katex-display .katex-html .mord");
  assert.equal(await copySelection(), `$$\n${expression}\n$$`);

  await click('button[title="复制回复"]');
  assert.equal(await evaluate("navigator.clipboard.readText()"), reply.text);

  await select(original);
  await waitFor("document.querySelector('.annotation-add')");
  await click(".annotation-add");
  await waitFor("document.querySelector('.annotation-editor textarea')");
  await fill(".annotation-editor textarea", "重算加权距离。");
  await key("Enter");
  await click(".send-button");
  await waitFor("annotationFixture.requests.some(r=>r.method==='turn/start')");
  const sent = await evaluate(
    "annotationFixture.requests.find(r=>r.method==='turn/start').params.input[0].text",
  );
  const captured = parseAnnotations(sent).annotations[0];
  assertMarkdown(captured.text);

  const updated = history.concat({
    id: "new-annotation",
    type: "userMessage",
    content: [{ type: "text", text: sent }],
  });
  await evaluate(`annotationFixture.setHistory(${JSON.stringify(updated)})`);
  await page("Page.reload");
  await waitFor(
    "document.querySelector('[data-message-id=new-annotation] summary')",
  );
  const card = '[data-message-id="new-annotation"] .annotation-card';
  await click(card + " summary");
  await waitFor(
    `document.querySelector(${JSON.stringify(card + " .katex-display")})`,
  );
  const layouts = [];
  for (const theme of ["light", "dark"]) {
    await page("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
      await setPageZoom(zoom);
      await waitFor(`Math.abs(devicePixelRatio - ${zoom}) < 0.01`);
      const layout = await evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(card)});
        const summary = card.querySelector("summary").getBoundingClientRect();
        const quote = card.querySelector("blockquote");
        const formula = quote.querySelector(".katex-display");
        return {
          dpr: devicePixelRatio,
          width: innerWidth,
          height: innerHeight,
          right: card.getBoundingClientRect().right,
          menuLeft: summary.left,
          menuWidth: summary.width,
          formulaWidth: formula.clientWidth,
          quoteWidth: quote.clientWidth,
        };
      })()`);
      assert(Math.abs(layout.width - 1440 / zoom) <= 1);
      assert(layout.right <= layout.width + 1, `${theme} ${zoom}`);
      assert(layout.menuLeft >= 0 && layout.menuWidth > 24);
      assert(
        layout.formulaWidth > 0 && layout.formulaWidth <= layout.quoteWidth,
      );
      layouts.push({ theme, zoom, ...layout });
    }
    await setPageZoom(1);
    await waitFor("devicePixelRatio === 1");
    await screenshot(`markdown-quote-${theme}`);
  }
  await select(card + " blockquote");
  assertMarkdown(await copySelection());
  await click('[data-message-id="new-annotation"] button[title="复制消息"]');
  const copiedMessage = await evaluate("navigator.clipboard.readText()");
  assert(copiedMessage.includes("**加权距离**"));
  assert(copiedMessage.includes(`> ${expression}`));

  await click(original + ' a[href$="quote.md"]');
  await waitFor(
    "document.querySelector('.file-markdown-preview .ProseMirror strong')",
  );
  await select(".file-markdown-preview .ProseMirror");
  const file = await copySelection();
  assert.match(file, /## Preview copy\n\n\*\*Bold\*\* and \$x\^2\$\./);
  await screenshot("markdown-file-copy");
  await page("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await click('button[title="折叠对话详情"]');
  await waitFor(
    'innerWidth === 390 && devicePixelRatio === 2 && getComputedStyle(document.querySelector(".sidebar")).visibility === "hidden" && !document.querySelector(".toast")',
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(card)}).scrollIntoView({ block: "center" })`,
  );
  await screenshot("markdown-quote-mobile-dark");
  await writeFile(
    join(output, "markdown-results.json"),
    JSON.stringify(
      { passed: true, build: buildInfo, legacyCopied, file, layouts },
      null,
      2,
    ),
  );
}
