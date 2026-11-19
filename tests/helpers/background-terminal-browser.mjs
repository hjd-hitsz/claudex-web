import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function backgroundTerminalBrowser(url, cookie, output) {
  const { chromium } = await import(
    pathToFileURL(process.env.PLAYWRIGHT_MODULE)
  );
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    args: ["--disable-gpu"],
  });
  try {
    await mkdir(output, { recursive: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const [name, value] = cookie.split("=");
    await context.addCookies([
      { name, value, url, secure: true, httpOnly: true },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(url);
    const button = (name) => page.getByRole("button", { name, exact: true });
    const toggle = page.getByRole("checkbox", {
      name: "为Codex开启后台终端功能",
      exact: true,
    });
    const close = () => button("关闭窗口").click();
    async function check(expected) {
      await toggle.waitFor();
      await page.waitForFunction((expected) => {
        const input = document.querySelector(
          ".background-terminal-setting input",
        );
        return input && !input.disabled && input.checked === expected;
      }, expected);
    }
    await button("设置").click();
    await check(false);
    const preferences = page.getByRole("region", { name: "其他设置" });
    assert.equal(
      await preferences
        .getByRole("checkbox", { name: "为Codex开启后台终端功能", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page.locator(".background-terminal-setting").innerText(),
      "为Codex开启后台终端功能",
    );
    assert.equal(
      await page
        .locator(".backend-card")
        .filter({ hasText: "Claude Code" })
        .getByText("为Codex开启后台终端功能")
        .count(),
      0,
    );
    await toggle.click();
    await check(true);
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, "settings.png") });
    await page.reload();
    await button("插件与连接").click();
    assert.equal(await toggle.count(), 0);
    await close();
    await button("设置").click();
    await check(true);
    await toggle.click();
    await check(false);
    await close();
    await button("设置").click();
    await check(false);
    await toggle.click();
    await check(true);
    await page.setViewportSize({ width: 390, height: 780 });
    await toggle.scrollIntoViewIfNeeded();
    const bounds = await toggle.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.screenshot({ path: join(output, "settings-mobile.png") });
    await close();
    await page.setViewportSize({ width: 1280, height: 900 });
    return {
      async inspectTask(command) {
        const group = page
          .locator(".project-heading button[aria-expanded=false]")
          .first();
        const row = page
          .locator(".thread-row")
          .filter({ hasText: "后台协议隔离验证" })
          .first();
        while (!(await row.isVisible()) && (await group.count()))
          await group.click();
        await row.click();
        await button("插件与连接").click();
        await page
          .locator(".catalog-card")
          .filter({ hasText: "后台终端 MCP" })
          .getByText(/4 项工具/)
          .waitFor()
          .catch(async (error) => {
            throw new Error(await page.locator(".catalog-list").innerText(), {
              cause: error,
            });
          });
        await close();
        const composer = page.locator(".composer .ProseMirror");
        await composer.fill("/stop");
        await composer.press("Enter");
        const dialog = page
          .getByRole("dialog")
          .filter({ hasText: "清理后台终端" });
        await dialog
          .getByRole("button", { name: "停止全部后台终端" })
          .waitFor();
        assert.ok((await dialog.innerText()).includes(command));
        await page.screenshot({ path: join(output, "tasks.png") });
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
