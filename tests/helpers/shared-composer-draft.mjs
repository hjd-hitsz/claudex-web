import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { switchComposerBackend } from "./settings-navigation.mjs";

export async function verifySharedComposerDraft({
  page,
  composer,
  newChat,
  screenshot,
  profile,
  desktop,
}) {
  await newChat.click();
  const draft = "请检查随草稿保留的图片、文件和代码引用。";
  await composer.fill(draft);
  const code = "return total + 1";
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    context.fillStyle = "#c1d6ff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#143269";
    context.font = "24px sans-serif";
    context.fillText("Shared draft", 25, 66);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const imageName = "shared-draft.png";
  const fileName = "shared-notes.txt";
  const fileText = "普通文件附件原文。";
  const image = join(profile, imageName);
  const file = join(profile, fileName);
  await Promise.all([
    writeFile(image, Buffer.from(png, "base64")),
    writeFile(file, fileText),
  ]);
  await page
    .locator('.composer input[type="file"]')
    .setInputFiles([image, file]);
  await composer.press("End");
  await composer.press("Enter");
  await composer.evaluate((editor, code) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", code + "\n");
    clipboardData.setData(
      "vscode-editor-data",
      JSON.stringify({
        version: 1,
        mode: "python",
        isFromEmptySelection: true,
        multicursorText: null,
        isBlock: false,
      }),
    );
    editor.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, code);
  const previewImage = page.getByRole("button", {
    name: `预览 ${imageName}`,
    exact: true,
  });
  const previewFile = page.getByRole("button", {
    name: `预览 ${fileName}`,
    exact: true,
  });
  const reference = page.locator(".composer .code-file-attachment");
  async function verify(name) {
    await composer.waitFor();
    await previewImage.waitFor();
    await previewFile.waitFor();
    await reference.waitFor();
    assert((await composer.innerText()).includes(draft));
    assert((await composer.innerText()).includes(code));
    assert.equal(
      await reference.locator(".code-file-name").innerText(),
      "source.py",
    );
    assert.equal(await reference.locator(".code-file-line").innerText(), ":7");
    assert.equal(
      await previewImage.locator("img").evaluate((img) => img.naturalWidth),
      200,
    );
    await screenshot(name);
  }
  await verify("07-codex-shared-attachments");
  await switchComposerBackend(page, "Claude Code");
  await verify("08-claude-shared-attachments");
  await previewFile.click();
  assert.equal(
    await page.locator(".attachment-preview-body pre").innerText(),
    fileText,
  );
  await page.keyboard.press("Escape");
  await switchComposerBackend(page, "Codex");
  await verify("09-codex-returned-attachments");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await switchComposerBackend(page, "Antigravity");
  await verify("10-agy-shared-attachments-dark-mobile");
  await page.getByTitle(`移除 ${imageName}`, { exact: true }).click();
  await page.getByTitle(`移除 ${fileName}`, { exact: true }).click();
  await reference.locator(".code-file-remove").click();
  await switchComposerBackend(page, "Codex");
  await composer.waitFor();
  assert.equal(await previewImage.count(), 0);
  assert.equal(await previewFile.count(), 0);
  assert.equal(await reference.count(), 0);
  await screenshot("11-codex-removed-attachments-dark-mobile");
  await composer.fill("");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(desktop);
  console.log(
    "PASS Codex → Claude Code → Codex → Antigravity 保留正文、实际图片和文件、代码位置，移除后切换仍保持移除",
  );
}
