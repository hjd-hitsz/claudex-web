import assert from "node:assert/strict";

export async function holdDocumentEditor(page) {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/document-editor.js", async (route) => {
    await pending;
    await route.continue();
  });
  return release;
}

export async function checkComposerInitialization(page, release) {
  const fallback = page.locator(".markdown-composer > textarea");
  await fallback.and(page.locator(":focus")).waitFor({ timeout: 3000 });
  await fallback.fill("短对话加载期间的草稿");
  await page.getByRole("button", { name: /^超长对话性能验证/ }).click();
  await fallback.and(page.locator(":focus")).waitFor();
  await fallback.fill("长对话加载期间的草稿");
  await page.getByRole("button", { name: /^简短对话/ }).click();
  await fallback.and(page.locator(":focus")).waitFor();
  assert.equal(await fallback.inputValue(), "短对话加载期间的草稿");
  await page.keyboard.insertText("，继续输入");
  assert.equal(await fallback.inputValue(), "短对话加载期间的草稿，继续输入");
  const text = "加载期间选择这两个字继续";
  await fallback.fill(text);
  await fallback.evaluate((element) => {
    const start = element.value.indexOf("两个字");
    element.setSelectionRange(start, start + 3);
  });
  const height = (await fallback.boundingBox()).height;
  release();
  await page.locator(".markdown-composer .ProseMirror:focus").waitFor();
  await page.waitForFunction(() => getSelection().toString() === "两个字");
  const viewport = page.locator(".document-editor-viewport");
  assert(
    Math.abs((await viewport.boundingBox()).height - height) < 1,
    "初始化前后编辑区保持尺寸一致",
  );
  assert.equal(
    await page.locator(".document-editor-viewport .milkdown").count(),
    1,
  );
  await page.keyboard.insertText("替换");
  await page.waitForFunction(
    () => localStorage.getItem("cx-draft-short") === "加载期间选择这替换继续",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("cx-draft-long")),
    "长对话加载期间的草稿",
  );
}

export async function checkComposerCompositionHandoff(page, url) {
  const release = await holdDocumentEditor(page);
  await page.goto(url);
  await page.getByRole("button", { name: /^简短对话/ }).click();
  const fallback = page.locator(".markdown-composer > textarea");
  await fallback.and(page.locator(":focus")).waitFor();
  await fallback.fill("前文后文");
  await fallback.evaluate((element) => element.setSelectionRange(2, 2));
  const device = await page.context().newCDPSession(page);
  try {
    await device.send("Input.imeSetComposition", {
      text: "buzai",
      selectionStart: 5,
      selectionEnd: 5,
    });
    assert.equal(await fallback.inputValue(), "前文buzai后文");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Control+Enter");
    assert.equal(await fallback.inputValue(), "前文buzai后文");
    release();
    await page.locator(".document-editor-viewport .milkdown").waitFor({
      state: "attached",
    });
    assert(await fallback.and(page.locator(":focus")).isVisible());
    assert.equal(
      await page.evaluate(() => localStorage.getItem("cx-draft-short")),
      "前文后文",
    );
    await device.send("Input.insertText", { text: "不再" });
    await page.locator(".markdown-composer .ProseMirror:focus").waitFor();
    await page.keyboard.insertText("跳行");
    await page.waitForFunction(
      () => localStorage.getItem("cx-draft-short") === "前文不再跳行后文",
    );
    assert.equal(
      await page.evaluate(() =>
        window.historyFixture.requests.some((r) => r.method === "turn/start"),
      ),
      false,
    );
  } finally {
    release();
    await device.detach();
  }
}
