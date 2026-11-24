import assert from "node:assert/strict";
import { join } from "node:path";

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
  async function checkItem(text, offset) {
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
    assert.equal((await draft()).trimEnd(), "- " + text);
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
    await checkItem("前文拼音后文", 4);
    await keyboard.press("Backspace");
    await checkItem("前文拼音后文", 4);
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
