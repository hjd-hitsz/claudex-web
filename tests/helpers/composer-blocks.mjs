import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkComposerBlocks(page, output) {
  const field = page.locator(".markdown-composer .ProseMirror");
  const viewport = page.locator(".document-editor-viewport");
  const draft = () =>
    page.evaluate(() => localStorage.getItem("cx-draft-short"));
  async function clear() {
    await field.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  }
  async function paste(text, html = "", language = "") {
    await field.evaluate(
      (element, { text, html, language }) => {
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", text);
        if (html) clipboard.setData("text/html", html);
        if (language)
          clipboard.setData(
            "vscode-editor-data",
            JSON.stringify({ mode: language }),
          );
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        );
      },
      { text, html, language },
    );
  }
  for (const block of [
    {
      source: "```js\nconst value = 42;\n```",
      selector: ".milkdown-code-block",
    },
    { source: "$$\nx^2+y^2=1\n$$", selector: ".katex" },
    {
      source: "| 名称 | 值 |\n| --- | --- |\n| alpha | 42 |",
      selector: "table",
    },
    { source: "- [ ] 第一项\n- [x] 第二项", selector: "li" },
  ]) {
    await clear();
    await page.keyboard.insertText("前文后文");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await paste("\n\n" + block.source + "\n\n");
    await field.locator(block.selector).first().waitFor();
    await page.keyboard.insertText("续写");
    const text = await draft();
    assert(text.startsWith("前文"), text);
    assert(text.endsWith("续写后文"), text);
    if (block.source.startsWith("```"))
      assert(text.includes(block.source), text);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    assert.equal(await draft(), "前文后文", "一次撤销粘贴恢复原段落及光标");
    await page.keyboard.press("Control+y");
    await field.locator(block.selector).first().waitFor();
  }
  await clear();
  await page.keyboard.insertText("前文后文");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await paste(" **格式** ");
  assert.equal(await draft(), "前文 **格式** 后文");
  await paste("  ");
  assert.equal(await draft(), "前文 **格式**   后文");
  await clear();
  await paste("const value = 42;", "", "javascript");
  assert((await draft()).includes("```javascript\nconst value = 42;\n```"));
  await page.keyboard.insertText("代码后正文");
  assert((await draft()).endsWith("代码后正文"));
  await clear();
  await page.keyboard.insertText("前文替换后文");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await paste("\n\n```js\nlet n = 1;\n```\n\n");
  await page.keyboard.insertText("续写");
  assert((await draft()).endsWith("续写后文"));
  assert(!(await draft()).includes("替换"));
  const code = field.locator(".cm-content");
  await code.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" // 编辑代码");
  assert((await draft()).includes("// 编辑代码"));
  await field.focus();
  await page.keyboard.press("Control+End");
  await paste(" **格式**", "<p><strong>格式</strong></p>");
  assert((await draft()).includes("**格式**"));
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "blocks-and-caret.png") });

  const handle = page.getByRole("separator", { name: "调整消息输入框高度" });
  await handle.focus();
  await page.keyboard.press("Home");
  const automatic = (await viewport.boundingBox()).height;
  await page.keyboard.press("Shift+ArrowUp");
  await page.waitForFunction(
    (height) =>
      document.querySelector(".document-editor-viewport").clientHeight >
      height + 30,
    automatic,
  );
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2, box.y - 70, { steps: 5 });
  await page.mouse.up();
  assert(
    (await viewport.boundingBox()).height > automatic + 100,
    "连续拖动保持指针捕获",
  );
  const text = await draft();
  const dockBefore = await page.locator(".composer-surface").boundingBox();
  await page.getByRole("button", { name: "展开输入框", exact: true }).click();
  const retained = page.locator(".composer-placeholder");
  const dockAfter = await retained.boundingBox();
  for (const key of ["x", "y", "width", "height"])
    assert(
      Math.abs(dockAfter[key] - dockBefore[key]) < 1,
      "放大时保留底部输入区的位置与尺寸",
    );
  assert.equal(await field.count(), 1, "只读预览与实际编辑器的节点隔离");
  assert.equal(
    await page.getByRole("button", { name: "发送消息", exact: true }).count(),
    1,
  );
  await page.screenshot({ path: join(output, "expanded-with-dock.png") });
  assert.equal(await draft(), text);
  const dialog = page.getByRole("dialog", { name: "编辑消息", exact: true });
  assert(await dialog.isVisible());
  const initialWidth = (await dialog.boundingBox()).width;
  const windowHandle = page.getByRole("button", {
    name: "调整窗口大小",
    exact: true,
  });
  await windowHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    (width) =>
      document.querySelector(".composer-surface[open]").getBoundingClientRect()
        .width <
      width - 5,
    initialWidth,
  );
  await page.keyboard.press("Home");
  const corner = await windowHandle.boundingBox();
  await page.mouse.move(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    corner.x + corner.width / 2 + 30,
    corner.y + corner.height / 2 + 20,
    { steps: 5 },
  );
  await page.mouse.up();
  const windowWidth = (await dialog.boundingBox()).width;
  assert(windowWidth > initialWidth + 30, "窗口通过公共手柄拖动调节尺寸");
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "expanded-input.png") });
  await page.getByRole("button", { name: "收起输入框", exact: true }).click();
  assert.equal(await retained.count(), 0);
  await page.getByRole("button", { name: "展开输入框", exact: true }).click();
  assert(
    Math.abs((await dialog.boundingBox()).width - windowWidth) < 1,
    "重开恢复窗口尺寸",
  );
  await field.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("窗口内编辑");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert((await draft()).includes("窗口内编辑"), await draft());
  await page.keyboard.press("Control+z");
  assert.equal(await draft(), text, "关闭编辑窗口后保留原文档撤销栈");
  const manual = (await viewport.boundingBox()).height;
  await page.reload();
  await field.waitFor();
  await page.waitForFunction(
    (height) =>
      Math.abs(
        document
          .querySelector(".document-editor-viewport")
          .getBoundingClientRect().height - height,
      ) < 1,
    manual,
  );
  assert.equal(await draft(), text, "刷新恢复手动高度和原草稿");
  await page.getByRole("button", { name: "展开输入框", exact: true }).click();
  assert(
    Math.abs((await dialog.boundingBox()).width - windowWidth) < 1,
    "刷新恢复编辑窗口尺寸",
  );
  await windowHandle.focus();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "关闭编辑窗口", exact: true }).click();
  await handle.focus();
  await page.keyboard.press("Home");
  await clear();
}
