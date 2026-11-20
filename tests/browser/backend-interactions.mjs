import { tmpdir } from "node:os";
import { testBrowserZoom } from "./browser-zoom.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import {
  verifyShellInteractions,
  verifyZoomedSearchDialog,
} from "./shell-interaction-scenarios.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const main = process.env.UI_MAIN === "1";
const before = process.env.UI_BEFORE === "1";
const build = process.env.UI_BUILD_DIR || join(root, "client/dist");
const output = join(
  root,
  ".cache/backend-interactions",
  before ? "before" : main ? "main" : "dual",
);
await mkdir(output, { recursive: true });
const data = {
  main,
  markdown: "交互对照问题",
  claudeItems: [],
  projectSwitcher: !main && !before,
};
const server = http.createServer(async (req, res) => {
  if (serveDemoSession(req, res)) return;
  try {
    const path = new URL(req.url, "http://fixture").pathname;
    let bytes = await readFile(join(build, path === "/" ? "index.html" : path));
    if (path === "/")
      bytes = bytes
        .toString()
        .replace(
          "<head>",
          `<head><script>(${backendFixture.toString()})(${JSON.stringify(data)})</script>`,
        );
    res
      .writeHead(200, {
        "Content-Type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
          }[extname(path)] || "text/html",
      })
      .end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "backend-ui-"));
const context = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1440, height: 1000 },
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
try {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const input = page.locator(".composer .ProseMirror");
  await input.waitFor();
  await page.locator(".user-bubble").waitFor();
  const capture = (name) =>
    page.screenshot({
      path: join(output, name + ".png"),
      animations: "disabled",
    });
  if (!before && !main) await verifyShellInteractions(page, capture);
  const metrics = {};
  await input.fill("保留的输入草稿");
  await page.evaluate(() => {
    window.originalComposer = document.querySelector(".composer .ProseMirror");
  });
  await page.getByRole("button", { name: "展开对话详情", exact: true }).click();
  await page.getByRole("region", { name: "对话功能", exact: true }).waitFor();
  await capture("workspace-open");
  await page.getByRole("button", { name: "折叠对话详情", exact: true }).click();
  assert.equal(await input.innerText(), "保留的输入草稿");
  await page.getByRole("button", { name: /^搜索对话/ }).click();
  const search = page.getByPlaceholder("按标题或内容搜索对话");
  await search.fill("旧版未分类");
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  assert.equal(await input.innerText(), "保留的输入草稿");
  await page.getByRole("button", { name: "技能", exact: true }).click();
  await page.getByText("测试技能", { exact: true }).waitFor();
  await capture("skills");
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await page.evaluate(() =>
    window.backendSocket.emit("turn/started", {
      threadId: "legacy",
      turn: {
        id: "active",
        status: "inProgress",
        startedAt: Date.now() / 1000,
      },
    }),
  );
  await page.getByRole("button", { name: "停止任务", exact: true }).waitFor();
  const model = page.getByLabel("模型", { exact: true });
  assert.equal(
    await model.isDisabled(),
    before,
    "运行中可为下一轮选择同供应商模型",
  );
  const second = await model
    .locator("option")
    .evaluateAll(
      (options) =>
        options.find((o) => o.textContent.endsWith("Second Model")).value,
    );
  await capture("running-model-selection");
  if (!before) await model.selectOption(second);
  assert.equal(await input.innerText(), "保留的输入草稿");
  await page.getByRole("button", { name: "技能", exact: true }).click();
  await page.getByText("测试技能", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await page.evaluate(() =>
    window.backendSocket.emit("turn/completed", {
      threadId: "legacy",
      turn: {
        id: "active",
        status: "completed",
        completedAt: Date.now() / 1000,
      },
    }),
  );
  await page.getByRole("button", { name: "调整思考强度", exact: true }).click();
  await page.getByRole("slider", { name: "思考强度", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "调整思考强度", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await input.fill("第一行");
  await input.press("End");
  await input.press("Enter");
  await input.pressSequentially("第二行");
  assert((await input.innerText()).includes("第二行"));
  assert.equal(
    await page.evaluate(() =>
      window.fixtureRequests.some((r) => r.method === "turn/start"),
    ),
    false,
    "Enter 保持换行",
  );
  await input.fill("保留的输入草稿");
  if (!main && !before) {
    const resumes = await page.evaluate(
      () =>
        window.fixtureRequests.filter(
          (request) => request.method === "thread/resume",
        ).length,
    );
    await page.evaluate(() =>
      window.backendSocket.setBackendReady("codex", false),
    );
    await page.waitForFunction(
      () => document.querySelector(".send-button").disabled,
    );
    assert.equal(await input.innerText(), "保留的输入草稿");
    await page.evaluate(() =>
      window.backendSocket.setBackendReady("codex", true),
    );
    await page.waitForFunction(
      (count) =>
        window.fixtureRequests.filter(
          (request) => request.method === "thread/resume",
        ).length > count,
      resumes,
    );
    await page.waitForFunction(
      () => !document.querySelector(".send-button").disabled,
    );
    assert.equal(await input.innerText(), "保留的输入草稿");
    assert.equal(
      await page.evaluate(
        () =>
          window.originalComposer ===
          document.querySelector(".composer .ProseMirror"),
      ),
      true,
    );
    await capture("backend-recovered-draft");
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (v) => (document.documentElement.dataset.theme = v),
      theme,
    );
    for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
      await page.evaluate(
        (v) => (document.documentElement.style.zoom = v),
        zoom,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await capture(`desktop-${theme}-${zoom}`);
      metrics[`${theme}-${zoom}`] = await page.evaluate(() => {
        const r = document.querySelector(".composer").getBoundingClientRect();
        return {
          width: r.width,
          height: r.height,
          inputLineHeight: getComputedStyle(
            document.querySelector(".ProseMirror"),
          ).lineHeight,
        };
      });
    }
  }
  await page.evaluate(() => (document.documentElement.style.zoom = 1));
  await page.setViewportSize({ width: 390, height: 844 });
  const breadcrumb = page.locator(
    ".topbar .project-switcher > button, .topbar .breadcrumb > button",
  );
  assert.equal(
    await breadcrumb.isVisible(),
    !before,
    "窄屏保留当前项目及项目切换入口",
  );
  await capture("mobile-chat");
  await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
  await capture("mobile-sidebar");
  await page
    .locator('.project-heading > button[title="未指定项目的对话"]')
    .click();
  await page.getByText("客户端未分类", { exact: true }).waitFor();
  await capture("mobile-unclassified");
  if (!before) {
    await page
      .getByText("旧版未分类与 Markdown", { exact: true })
      .first()
      .click();
    await input.waitFor();
    assert.equal(await input.innerText(), "保留的输入草稿");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  if (data.projectSwitcher) {
    const trigger = page.getByRole("button", { name: /^切换项目文件夹/ });
    const groups = page.getByRole("group", { name: "项目文件夹" });
    const threadTrigger = page.getByRole("button", { name: /^切换对话，/ });
    const threads = page.getByRole("group", { name: "当前分组的对话" });
    const directory = page.getByRole("dialog", { name: "选择工作目录" });
    const requests = () => page.evaluate(() => window.fixtureRequests);
    const previousRequests = (await requests()).length;
    await trigger.press("Enter");
    await groups.waitFor();
    assert.deepEqual(await groups.getByRole("button").allTextContents(), [
      "project",
      "Pinned",
      "未分类",
    ]);
    assert.equal(
      await groups
        .getByRole("button", { name: "未分类" })
        .getAttribute("aria-current"),
      "true",
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await groups
        .getByRole("button", { name: "project", exact: true })
        .evaluate((element) => document.activeElement === element),
      true,
    );
    await page.keyboard.press("Escape");
    await groups.waitFor({ state: "hidden" });
    assert.equal(
      await trigger.evaluate((element) => document.activeElement === element),
      true,
    );
    await trigger.click();
    await groups.getByRole("button", { name: "未分类", exact: true }).click();
    assert.equal(await input.innerText(), "保留的输入草稿");

    await threadTrigger.press("ArrowDown");
    await threads.locator("button:focus").waitFor();
    assert.deepEqual(await threads.getByRole("button").allTextContents(), [
      "旧版未分类与 Markdown",
      "客户端未分类",
    ]);
    assert.equal(
      await threads.locator("button:focus").textContent(),
      "旧版未分类与 Markdown",
    );
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: /当前为 客户端未分类$/ }).waitFor();
    const focusedInput = input.and(page.locator(":focus"));
    await focusedInput.waitFor();
    await threadTrigger.click();
    assert.equal(
      await threads.locator('button[aria-current="true"]').textContent(),
      "客户端未分类",
    );
    await threads
      .getByRole("button", { name: "旧版未分类与 Markdown" })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".composer .ProseMirror")?.innerText ===
        "保留的输入草稿",
    );

    await trigger.click();
    await groups.getByRole("button", { name: "Pinned", exact: true }).click();
    await page.getByRole("button", { name: /当前为 Pinned$/ }).waitFor();
    await page
      .getByRole("button", { name: /当前为 仅有置顶对话的文件夹$/ })
      .waitFor();
    await trigger.click();
    await groups.getByRole("button", { name: "Pinned", exact: true }).waitFor();
    await capture("project-switcher-pinned");
    await page.keyboard.press("Escape");
    await threadTrigger.click();
    assert.deepEqual(await threads.getByRole("button").allTextContents(), [
      "仅有置顶对话的文件夹",
    ]);
    await page.keyboard.press("Escape");
    await input.fill("置顶对话的独立草稿");
    const switchProject = async (name, title) => {
      await trigger.click();
      await groups.getByRole("button", { name, exact: true }).click();
      await page
        .getByRole("button", { name: `切换对话，当前为 ${title}`, exact: true })
        .waitFor();
    };
    await switchProject("project", "发送较晚的进行中对话");
    await threadTrigger.click();
    assert.deepEqual(await threads.getByRole("button").allTextContents(), [
      "发送较晚的进行中对话",
      "发送较早的进行中对话",
      "Claude 原生消息归属",
    ]);
    assert.equal(
      await threads.locator(".conversation-switcher-status .spin").count(),
      2,
    );
    assert.deepEqual(
      await threads
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-description")),
        ),
      ["进行中", "进行中", "已结束"],
    );
    await capture("project-running-priority");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    const searchDialog = page.getByRole("dialog", { name: "搜索对话" });
    const firstResult = searchDialog
      .locator(".search-results > button b")
      .first();
    await firstResult
      .getByText("发送较晚的进行中对话", { exact: true })
      .waitFor();
    await page.evaluate(() =>
      window.backendSocket.emit("turn/completed", {
        threadId: "project-running-latest",
        turn: {
          id: "running-latest",
          status: "completed",
          startedAt: 30,
          completedAt: 60,
        },
      }),
    );
    await firstResult
      .getByText("发送较早的进行中对话", { exact: true })
      .waitFor();
    await searchDialog
      .getByRole("button", { name: /发送较早的进行中对话/ })
      .click();
    await focusedInput.waitFor();
    await switchProject("Pinned", "仅有置顶对话的文件夹");
    await page.waitForFunction(
      () =>
        document.querySelector(".composer .ProseMirror")?.innerText ===
        "置顶对话的独立草稿",
    );
    await switchProject("project", "发送较早的进行中对话");
    await page.evaluate(() =>
      window.backendSocket.emit("turn/completed", {
        threadId: "project-running-first",
        turn: {
          id: "running-first",
          status: "completed",
          startedAt: 20,
          completedAt: 70,
        },
      }),
    );
    await threadTrigger.click();
    assert.deepEqual(await threads.getByRole("button").allTextContents(), [
      "发送较早的进行中对话",
      "发送较晚的进行中对话",
      "Claude 原生消息归属",
    ]);
    assert.equal(
      await threads.locator(".conversation-switcher-status .spin").count(),
      0,
    );
    await page.keyboard.press("Escape");
    await switchProject("未分类", "旧版未分类与 Markdown");
    await page.getByRole("button", { name: /当前为 未分类$/ }).waitFor();
    await focusedInput.waitFor();
    assert.equal(await input.innerText(), "保留的输入草稿");
    await capture("conversation-switch-focus");
    await switchProject("project", "发送较早的进行中对话");
    await switchProject("未分类", "旧版未分类与 Markdown");
    await trigger.click();
    await input.click();
    await groups.waitFor({ state: "hidden" });
    assert.equal(await directory.count(), 0);
    assert.equal(
      (await requests())
        .slice(previousRequests)
        .some(({ method }) =>
          ["fs/readDirectory", "thread/start", "lan/thread/move"].includes(
            method,
          ),
        ),
      false,
    );

    await page.locator(".composer-meta > button").click();
    await directory.waitFor();
    await page.waitForFunction(() =>
      window.fixtureRequests.some(
        ({ method }) => method === "fs/readDirectory",
      ),
    );
    await directory.getByRole("button", { name: "关闭窗口" }).click();
    await testBrowserZoom({
      context: page.context(),
      page,
      artifacts: join(output, "browser-zoom"),
      async afterScale({ width, theme, scale }) {
        await verifyZoomedSearchDialog(
          page,
          scale === 1 || scale === 2
            ? () => capture(`search-dialog-${width}-${theme}-${scale}`)
            : undefined,
        );
        for (const [name, button, options] of [
          ["project-switcher", trigger, groups],
          ["conversation-switcher", threadTrigger, threads],
        ]) {
          await button.click();
          const bounds = await options.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return {
              left: box.left,
              top: box.top,
              right: box.right,
              bottom: box.bottom,
              width: innerWidth,
              height: innerHeight,
            };
          });
          assert.ok(
            bounds.left >= 0 &&
              bounds.top >= 0 &&
              bounds.right <= bounds.width &&
              bounds.bottom <= bounds.height,
            JSON.stringify({ name, ...bounds }),
          );
          if (scale === 1 || scale === 2)
            await capture(`${name}-${width}-${theme}-${scale}`);
          await page.keyboard.press("Escape");
          await options.waitFor({ state: "hidden" });
        }
      },
    });
  }
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      {
        passed: true,
        main,
        metrics,
        source:
          "同一隔离数据与实际浏览器操作；main 与双后端分别使用独立生产构建",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, main, output }));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  server.close();
}
