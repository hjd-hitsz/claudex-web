import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkNestedListComposition(page, output) {
  const { keyboard } = page;
  const field = page.locator(".markdown-composer .ProseMirror");
  await field.focus();
  await keyboard.press("Control+a");
  await keyboard.press("Backspace");
  await page.getByRole("button", { name: "展开输入框", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑消息" });
  await dialog.waitFor();
  await field.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      "text/plain",
      "- 外层条目\n  - 内层正文\n- 下一条外层正文",
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true }),
    );
  });
  await field.getByText("内层正文", { exact: true }).click();
  await keyboard.press("End");
  await keyboard.press("Enter");
  await field.evaluate((element) => {
    const next = element.querySelector(":scope > ul > li:last-child p");
    const fixture = new AbortController();
    element.addEventListener(
      "beforeinput",
      (event) => {
        if (event.inputType === "insertCompositionText")
          Object.defineProperty(event, "getTargetRanges", { value: () => [] });
      },
      { capture: true, signal: fixture.signal },
    );
    element.addEventListener(
      "input",
      (event) => {
        if (event.inputType !== "insertCompositionText") return;
        // Recreate a caret displaced to the next block on alternating updates.
        const moveCaret = () => getSelection().collapse(next.firstChild, 0);
        if (event.data === "dan") {
          Object.defineProperty(event, "data", { value: null });
          Object.defineProperty(event, "isComposing", { value: false });
          queueMicrotask(moveCaret);
        } else if (["d", "但是"].includes(event.data)) moveCaret();
      },
      { capture: true, signal: fixture.signal },
    );
    element.addEventListener("compositionend", () => fixture.abort(), {
      once: true,
    });
  });
  const item = field.locator("li li p").last();
  const device = await page.context().newCDPSession(page);
  const initialDraft = await page.evaluate(() =>
    localStorage.getItem("cx-draft-short"),
  );
  try {
    for (const [text, offset] of [
      ["d", 1],
      ["da", 0],
      ["dan", 3],
    ]) {
      await device.send("Input.imeSetComposition", {
        text,
        selectionStart: offset,
        selectionEnd: offset,
      });
      await page.waitForFunction(
        ({ text, offset }) => {
          const paragraph = document.querySelector(
            ".markdown-composer .ProseMirror li li:last-child p",
          );
          const selection = getSelection();
          return (
            paragraph?.textContent === text &&
            paragraph.contains(selection.anchorNode) &&
            selection.anchorOffset === offset
          );
        },
        { text, offset },
        { timeout: 3000 },
      );
    }
    if (output)
      await dialog.screenshot({
        path: join(output, "nested-list-composition-caret.png"),
        caret: "initial",
      });
    assert.equal(
      await page.evaluate(() => localStorage.getItem("cx-draft-short")),
      initialDraft,
    );
    await device.send("Input.insertText", { text: "但是" });
    await keyboard.insertText("留在这一项");
    assert.equal(await item.textContent(), "但是留在这一项");
    assert.equal(
      await field.locator(":scope > ul > li:last-child p").textContent(),
      "下一条外层正文",
    );
    const draft = await page.evaluate(() =>
      localStorage.getItem("cx-draft-short"),
    );
    assert.match(draft, /\n +- 但是留在这一项\n- 下一条外层正文/);
    await field.evaluate((element) => {
      const original = element.querySelector("li li:last-child p").firstChild;
      const next = element.querySelector(
        ":scope > ul > li:last-child p",
      ).firstChild;
      const selection = getSelection();
      selection.setBaseAndExtent(original, 0, original, 2);
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      next.replaceData(1, 2, "新词");
      selection.collapse(next, 3);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          isComposing: true,
          data: "新词",
        }),
      );
      element.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: "新词",
        }),
      );
    });
    await page.waitForFunction(() =>
      localStorage
        .getItem("cx-draft-short")
        ?.includes("- 新词留在这一项\n- 下一条外层正文"),
    );
    assert.equal(await item.textContent(), "新词留在这一项");
    assert.equal(
      await field.locator(":scope > ul > li:last-child p").textContent(),
      "下一条外层正文",
    );
    if (output)
      await dialog.screenshot({
        path: join(output, "misplaced-composition-recovered.png"),
        caret: "initial",
      });
    await keyboard.press("Control+z");
    assert.equal(await item.textContent(), "但是留在这一项");
    assert.equal(
      await field.locator(":scope > ul > li:last-child p").textContent(),
      "下一条外层正文",
    );
    await keyboard.press("Control+a");
    await keyboard.press("Backspace");
    await keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await device.detach();
  }
}

export async function checkExpandedListComposition(page, output) {
  const { keyboard } = page;
  const field = page.locator(".markdown-composer .ProseMirror");
  await field.focus();
  await keyboard.press("Control+a");
  await keyboard.press("Backspace");
  await page.getByRole("button", { name: "展开输入框", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑消息" });
  await dialog.waitFor();
  await keyboard.type("- ");
  await keyboard.insertText("上一条列表正文");
  await keyboard.press("Enter");
  const item = field.locator("li p").last();
  const draft = () =>
    page.evaluate(() => localStorage.getItem("cx-draft-short"));
  const initialDraft = await draft();
  const device = await page.context().newCDPSession(page);
  try {
    await device.send("Input.imeSetComposition", {
      text: "buzai",
      selectionStart: 5,
      selectionEnd: 5,
    });
    async function checkCaret(text, offset) {
      assert.deepEqual(
        await item.evaluate((paragraph) => {
          const selection = getSelection();
          return {
            text: paragraph.textContent,
            inside: paragraph.contains(selection.anchorNode),
            offset: selection.anchorOffset,
            collapsed: selection.isCollapsed,
          };
        }),
        { text, inside: true, offset, collapsed: true },
      );
    }
    await checkCaret("buzai", 5);
    for (const key of [
      "ArrowDown",
      "ArrowRight",
      "ArrowUp",
      "Home",
      "Escape",
      "Control+Enter",
    ]) {
      await keyboard.press(key);
      await checkCaret("buzai", 5);
      assert(await dialog.isVisible());
    }
    assert.equal(await draft(), initialDraft);
    assert.equal(
      await page.evaluate(() =>
        window.historyFixture.requests.some((r) => r.method === "turn/start"),
      ),
      false,
    );
    if (output)
      await dialog.screenshot({
        path: join(output, "expanded-list-composition-caret.png"),
        caret: "initial",
      });
    await device.send("Input.insertText", { text: "不再" });
    await checkCaret("不再", 2);
    await keyboard.insertText("跳行");
    await checkCaret("不再跳行", 4);
    assert.deepEqual(await field.locator("li").allTextContents(), [
      "上一条列表正文",
      "不再跳行",
    ]);
    await page.waitForFunction(
      () =>
        localStorage.getItem("cx-draft-short")?.trimEnd() ===
        "- 上一条列表正文\n- 不再跳行",
    );
    if (output)
      await dialog.screenshot({
        path: join(output, "expanded-list-composition-committed.png"),
        caret: "initial",
      });
    await keyboard.press("ArrowDown");
    assert(
      await field
        .locator(":scope > p")
        .last()
        .evaluate((paragraph) => {
          return paragraph.contains(getSelection().anchorNode);
        }),
      "选词后的方向键可以进入列表下方的正文",
    );
    await keyboard.press("Control+a");
    await keyboard.press("Backspace");
    await keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await field.and(page.locator(":focus")).waitFor();
  } finally {
    await device.detach();
  }
}

export async function checkComposerListInput(page, output) {
  const field = page.locator(".markdown-composer .ProseMirror");
  const { keyboard } = page;
  const device = await page.context().newCDPSession(page);
  const draft = () =>
    page.evaluate(() => localStorage.getItem("cx-draft-short"));
  async function clear() {
    await field.focus();
    await keyboard.press("Control+a");
    await keyboard.press("Backspace");
  }
  async function checkItem(text, offset, committed = text) {
    await page.waitForFunction(
      ({ text, offset }) => {
        const editor = document.querySelector(
          ".markdown-composer .ProseMirror",
        );
        const items = editor.querySelectorAll("li");
        const selection = getSelection();
        return (
          items.length === 1 &&
          items[0].querySelectorAll("p").length === 1 &&
          items[0].textContent === text &&
          selection.isCollapsed &&
          items[0].contains(selection.anchorNode) &&
          selection.anchorOffset === offset
        );
      },
      { text, offset },
      { timeout: 3000 },
    );
    assert.equal((await draft()).trimEnd(), "- " + committed);
  }
  try {
    await clear();
    await keyboard.type("- ");
    await keyboard.insertText("前文后文");
    await keyboard.press("Home");
    await keyboard.press("ArrowRight");
    await keyboard.press("ArrowRight");
    await checkItem("前文后文", 2);

    for (const text of ["pinyin", "拼音"])
      await device.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    await keyboard.press("Enter");
    await checkItem("前文拼音后文", 4, "前文后文");
    await keyboard.press("Backspace");
    await checkItem("前文拼音后文", 4, "前文后文");
    await device.send("Input.insertText", { text: "拼音" });

    for (const key of ["Enter", "Backspace", "Delete"])
      await field.dispatchEvent("keydown", { key, keyCode: 229 });
    await checkItem("前文拼音后文", 4);
    await keyboard.press("Backspace");
    await checkItem("前文拼后文", 3);
    await keyboard.insertText("继续");
    await checkItem("前文拼继续后文", 5);
    if (output)
      await page.locator(".composer").screenshot({
        path: join(output, "list-composition-caret.png"),
        caret: "initial",
      });

    await keyboard.press("Enter");
    assert.deepEqual(await field.locator("li").allTextContents(), [
      "前文拼继续",
      "后文",
    ]);
    await keyboard.press("Backspace");
    await keyboard.press("Backspace");
    await checkItem("前文拼继续后文", 5);
    await clear();
  } finally {
    await device.detach();
  }
}
