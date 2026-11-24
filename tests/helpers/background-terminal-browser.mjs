import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function backgroundTerminalBrowser(url, cookie, output, build) {
  const { chromium } = await import(
    pathToFileURL(process.env.PLAYWRIGHT_MODULE)
  );
  const profile = await mkdtemp(join(tmpdir(), "claudex-background-browser-"));
  let context;
  async function cleanup() {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
  try {
    await mkdir(output, { recursive: true });
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_PATH,
      args: ["--disable-gpu"],
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const [name, value] = cookie.split("=");
    await context.addCookies([
      { name, value, url, secure: true, httpOnly: true },
    ]);
    const page = await context.newPage();
    if (build)
      await page.route(/\/(app\.js|style\.css)$/, (route) =>
        route.fulfill({
          path: join(build, new URL(route.request().url()).pathname.slice(1)),
        }),
      );
    page.setDefaultTimeout(15000);
    await page.goto(url);
    const button = (name) => page.getByRole("button", { name, exact: true });
    const trigger = (count) => button(`后台终端，${count} 个运行中`);
    const menu = page.locator(".context-card").getByRole("region", {
      name: "后台终端",
      exact: true,
    });
    const task = (title) =>
      menu.getByRole("button", { name: new RegExp("^" + title) });
    const outputPanel = page.getByRole("region", { name: "后台终端输出" });
    function waitForSidebarClosed() {
      return page.waitForFunction(() => {
        const sidebar = document.querySelector(".sidebar");
        return !sidebar || sidebar.getBoundingClientRect().right < 1;
      });
    }
    const toggle = page.getByRole("checkbox", {
      name: "Codex 后台终端",
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
    async function checkSpacing(view) {
      const rows = await page
        .locator(".settings-preferences > div > label")
        .evaluateAll((labels) =>
          labels.map((label) => {
            const box = label.control.getBoundingClientRect();
            const text = document.createRange();
            text.selectNodeContents(label.lastChild);
            return {
              x: box.x,
              y: box.y + box.height / 2,
              textX: text.getBoundingClientRect().x,
            };
          }),
        );
      const distances = rows.slice(1).map((row, i) => row.y - rows[i].y);
      await writeFile(
        join(output, "spacing-" + view + ".json"),
        JSON.stringify({ rows, distances }, null, 2),
      );
      assert.equal(rows.length, 3);
      assert.ok(
        rows.every((row) => row.x === rows[0].x && row.textX === rows[0].textX),
      );
      assert.ok(
        Math.abs(distances[0] - distances[1]) <= 0.5,
        "复选框中心间距 " + distances.join(" / "),
      );
    }
    await button("设置").click();
    await check(false);
    await checkSpacing("desktop");
    const preferences = page.getByRole("region", { name: "通用" });
    assert.equal(
      await preferences
        .getByRole("checkbox", { name: "Codex 后台终端", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page.locator(".background-terminal-setting").innerText(),
      "Codex 后台终端",
    );
    assert.equal(
      await page
        .locator(".backend-card")
        .filter({ hasText: "Claude Code" })
        .getByText("Codex 后台终端")
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
    await checkSpacing("mobile");
    await page.setViewportSize({ width: 1280, height: 900 });
    await context.grantPermissions(["notifications"], { origin: url });
    await page.reload();
    await button("设置").click();
    await check(true);
    assert.equal(await button("允许系统通知").count(), 0);
    await checkSpacing("desktop-granted");
    await page.setViewportSize({ width: 390, height: 780 });
    await checkSpacing("mobile-granted");
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
          .getByText(/5 项工具/)
          .waitFor()
          .catch(async (error) => {
            throw new Error(await page.locator(".catalog-list").innerText(), {
              cause: error,
            });
          });
        await close();
        assert.equal(
          await trigger(1).locator("..").getAttribute("class"),
          "composer-tools",
        );
        await button("展开对话详情").click();
        await menu
          .getByRole("button", { name: "停止 项目架构检查与测试", exact: true })
          .waitFor();
        await trigger(1).click();
        await menu.waitFor({ state: "hidden" });
        await trigger(1).focus();
        await page.keyboard.press("Enter");
        await menu.waitFor();
        await page.screenshot({ path: join(output, "task-menu.png") });
        await page.setViewportSize({ width: 390, height: 780 });
        await waitForSidebarClosed();
        await button("显示侧栏").click();
        await button("收起侧栏").click();
        await waitForSidebarClosed();
        const menuBounds = await menu.boundingBox();
        assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390);
        await task("项目架构检查与测试").click({ trial: true });
        await menu.getByText(/^下次检查 /).waitFor();
        await page.screenshot({
          path: join(output, "task-menu-mobile.png"),
          animations: "disabled",
        });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({
          path: join(output, "task-menu-mobile-dark.png"),
          animations: "disabled",
        });
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 1280, height: 900 });
        const settings = await context.newPage();
        await settings.goto("chrome://settings/appearance");
        const zoom = settings.locator("#zoomLevel");
        const layouts = [];
        for (const scale of [0.8, 1, 1.25, 1.5, 2, 1]) {
          await zoom.selectOption(String(scale));
          await page.bringToFront();
          await page.reload();
          await trigger(1).click();
          const viewport = await page.evaluate(() => ({
            dpr: devicePixelRatio,
            width: innerWidth,
          }));
          const bounds = await menu.boundingBox();
          assert.ok(Math.abs(viewport.dpr - scale) < 0.02);
          assert.ok(Math.abs(viewport.width - 1280 / scale) <= 1);
          assert.ok(
            bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1,
          );
          await task("项目架构检查与测试").click({ trial: true });
          layouts.push({ viewport, bounds });
        }
        await settings.close();
        await writeFile(
          join(output, "task-layouts.json"),
          JSON.stringify(layouts, null, 2),
        );
        await task("项目架构检查与测试").click();
        await outputPanel
          .getByText(/架构检查通过.*Warning: 回归验证标准错误输出/s)
          .waitFor();
        await outputPanel.getByText(/^下次检查 /).waitFor();
        await page.screenshot({ path: join(output, "task-output.png") });
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
        await close();
      },
      async inspectSilentTask() {
        await trigger(2).click();
        await task("输出写入文件").click();
        await outputPanel.getByText("等待终端输出…", { exact: true }).waitFor();
        await outputPanel
          .getByText("重定向到文件的内容会保存在对应文件中。", { exact: true })
          .waitFor();
        await page.screenshot({ path: join(output, "task-output-empty.png") });
        await button("返回概览").click();
        await button("停止 输出写入文件").click();
        await trigger(1).waitFor();
        await task("输出写入文件").waitFor({ state: "hidden" });
        await task("项目架构检查与测试").click();
      },
      async inspectRescheduledCheck(nextCheckAt) {
        await page
          .getByText("构建仍在运行，将在七分钟后复查。", { exact: true })
          .waitFor();
        const time = outputPanel.locator(
          `time[datetime="${new Date(nextCheckAt).toISOString()}"]`,
        );
        await time.waitFor();
        assert.match(await time.textContent(), /^下次检查 /);
        await page.screenshot({
          path: join(output, "checkpoint-rescheduled.png"),
        });
      },
      async inspectCheckReceipt() {
        const receipt = page.getByRole("region", { name: "后台终端检查" });
        await receipt.getByText("检查时仍在运行", { exact: true }).waitFor();
        await page.reload();
        await receipt.getByText("检查时仍在运行", { exact: true }).waitFor();
        await page.screenshot({ path: join(output, "checkpoint-receipt.png") });
        await page.setViewportSize({ width: 390, height: 780 });
        await waitForSidebarClosed();
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({
          path: join(output, "checkpoint-receipt-mobile-dark.png"),
          animations: "disabled",
        });
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 1280, height: 900 });
        await receipt.getByRole("button", { name: "查看输出" }).click();
        await outputPanel.getByText("运行中", { exact: true }).waitFor();
      },
      async inspectCompletion({ emptyReply, before }) {
        const panel = page.getByRole("region", { name: "后台终端输出" });
        await panel.getByText("已完成", { exact: true }).waitFor();
        await panel
          .getByText(/架构检查通过.*Warning: 回归验证标准错误输出.*# pass 2/s)
          .waitFor();
        const wake = page.getByText("后台终端续跑", { exact: true });
        await wake.waitFor();
        const receipt = page.getByRole("region", { name: "后台任务结果" });
        if (!emptyReply) {
          const reply = page.getByText("已收到后台结果并继续处理。", {
            exact: true,
          });
          await reply.waitFor();
          assert.ok(
            await wake.evaluate(
              (element, answer) =>
                Boolean(
                  element.compareDocumentPosition(answer) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
                ),
              await reply.elementHandle(),
            ),
          );
          assert.equal(await receipt.count(), 0);
        } else if (before) {
          assert.equal(await receipt.count(), 0);
          await button("收起对话详情").click();
          await wake.click();
          const result = page.getByText("工具结果 · background_completed", {
            exact: true,
          });
          await result.click();
          await page.screenshot({ path: join(output, "empty-reply.png") });
          return;
        } else {
          await receipt
            .getByText("模型本轮未生成回复正文。", {
              exact: true,
            })
            .waitFor();
          await page.reload();
          await receipt
            .getByText("已完成 · 退出码 0", { exact: true })
            .waitFor();
          await page.locator(".composer .ProseMirror").waitFor();
          await page.screenshot({ path: join(output, "empty-reply.png") });
          await page.setViewportSize({ width: 390, height: 780 });
          await waitForSidebarClosed();
          await page.emulateMedia({ colorScheme: "dark" });
          await page.screenshot({
            path: join(output, "empty-reply-mobile-dark.png"),
            animations: "disabled",
          });
          await page.emulateMedia({ colorScheme: "light" });
          await page.setViewportSize({ width: 1280, height: 900 });
          await receipt.getByRole("button", { name: "查看输出" }).click();
          await panel.getByText(/# pass 2/).waitFor();
        }
        await page
          .getByRole("button", { name: "后台终端，1 个运行中", exact: true })
          .waitFor({ state: "hidden" });
        const download = page.waitForEvent("download");
        await panel.getByRole("link", { name: "完整日志" }).click();
        const saved = await download;
        assert.equal(await saved.failure(), null);
        await saved.saveAs(join(output, "actual-task.log"));
        await page.screenshot({ path: join(output, "task-completed.png") });
      },
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
