import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { composerReferenceFixture } from "../fixtures/composer-references.mjs";
import { historyPerformanceFixture } from "../fixtures/history-performance.mjs";

function slashFixture() {
  window.slashFixture = { fail: false, failSubmission: false };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (raw) {
    const request = JSON.parse(raw);
    let result;
    if (request.method === "skills/list")
      result = {
        data: [
          {
            skills: [
              { name: "demo-skill", path: "/demo/SKILL.md" },
              { name: "native-skill", native: true },
            ],
          },
        ],
        commands: [{ name: "usage", description: "原生命令" }],
      };
    if (
      (window.slashFixture.fail && request.method === "fs/readDirectory") ||
      (window.slashFixture.failSubmission && request.method === "turn/start")
    ) {
      setTimeout(
        () =>
          this.onmessage({
            data: JSON.stringify({
              id: request.id,
              error: { message: "模拟命令执行失败" },
            }),
          }),
        0,
      );
      return;
    }
    if (!result) return send.call(this, raw);
    setTimeout(
      () =>
        this.onmessage({
          data: JSON.stringify({
            id: request.id,
            result,
          }),
        }),
      0,
    );
  };
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const build = before ? join(root, ".cache/slash-commands/before") : root;
const dist = before ? join(build, "dist") : join(root, "client/dist");
const output = join(root, ".cache/slash-commands", before ? "before" : "after");
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response)) return;
  try {
    const path = new URL(request.url, "http://fixture").pathname;
    let body = await readFile(join(dist, path === "/" ? "index.html" : path));
    if (path === "/")
      body = body
        .toString()
        .replace(
          "<head>",
          `<head><script>(${historyPerformanceFixture.toString()})();(${composerReferenceFixture.toString()})();(${slashFixture.toString()})();localStorage.setItem('cx-current','short');</script>`,
        );
    response
      .writeHead(200, {
        "Content-Type":
          { ".js": "text/javascript", ".css": "text/css" }[extname(path)] ||
          (path === "/" ? "text/html" : "application/octet-stream"),
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "claudex-slash-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1040, height: 780 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];
const layouts = [];
let settings;
try {
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.getByRole("button", { name: /^简短对话/ }).click();
  const field = page.locator(".markdown-composer .ProseMirror");
  await field.waitFor();
  const menu = page.getByRole("listbox", { name: "快捷命令", exact: true });
  const option = (name) => menu.getByRole("option").filter({ hasText: name });
  async function type(text) {
    await field.fill("");
    await field.fill(text);
    await field.press("End");
  }
  await type("请先检查项目 /pl");
  if (before) {
    assert.equal(await menu.count(), 0);
    await page.screenshot({ path: join(output, "inline-menu.png") });
    await type("/pl");
    await option("/plan").waitFor();
    checks.push("开头可调用，正文中途缺少菜单");
  } else {
    await option("/plan").waitFor();
    await page.screenshot({ path: join(output, "inline-menu.png") });
    await field.press("Tab");
    assert.equal(await field.innerText(), "请先检查项目 /plan");
    await option("/plan").waitFor();
    await field.press("Enter");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await field.textContent(), "请先检查项目 ");
    assert.equal(
      await page
        .getByRole("button", { name: "计划模式", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await field.press("Control+z");
    assert.equal(await field.textContent(), "请先检查项目 /plan");
    await field.press("Control+Shift+z");
    assert.equal(await field.textContent(), "请先检查项目 ");
    checks.push("正文中途触发、Tab 补全、Enter 执行、正文保留及撤销重做");

    await type("前文 /mod 后文");
    await field.press("Home");
    await field.press("ArrowRight");
    await field.press("ArrowRight");
    for (let index = 0; index < 5; index++) await field.press("ArrowRight");
    await option("/model").click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await field.textContent(), "前文  后文");
    await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
    checks.push("移动光标到正文中间并点击命令，前后文字均保留");

    for (const text of ["/pl", "  /pl", "第一行\n/pl"]) {
      await type(text);
      await option("/plan").waitFor();
      const unchanged = await field.innerText();
      await field.press("Escape");
      await menu.waitFor({ state: "hidden" });
      assert.equal(await field.innerText(), unchanged);
    }
    for (const text of ["https://example.com/pl", "src/pl", "正文/pl"]) {
      await type(text);
      assert.equal(await menu.count(), 0);
    }
    await type("正文 @src/");
    await page
      .getByRole("listbox", { name: "引用建议", exact: true })
      .waitFor();
    assert.equal(await menu.count(), 0);
    checks.push(
      "开头、空格与换行触发，Esc 关闭，网址、路径和 @ 路径保持输入语义",
    );

    await type("继续处理 /dmsk");
    await option("demo-skill").click();
    await menu.waitFor({ state: "hidden" });
    await page
      .locator(".attachment-list")
      .getByText("demo-skill", { exact: true })
      .waitFor();
    assert.equal(await field.textContent(), "继续处理 ");
    await page
      .getByRole("button", { name: "移除 demo-skill", exact: true })
      .click();
    await type("原生技能正文 /native-sk");
    await option("native-skill").click();
    assert.equal(await field.textContent(), "/native-skill 原生技能正文 ");
    await type("原生命令正文 /usage");
    await option("/usage").click();
    await page.waitForFunction(() =>
      window.historyFixture.requests.some(
        (request) =>
          request.method === "turn/start" &&
          request.params.input[0].text === "/usage 原生命令正文 ",
      ),
    );
    checks.push("中途选择 Codex 技能、Claude 原生技能及原生命令保留正文");

    await page.evaluate(() => {
      window.historyFixture.socket.onmessage({
        data: JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "short",
            turn: { id: "reference-turn", status: "completed" },
          },
        }),
      });
      window.slashFixture.fail = true;
    });
    await type("失败时保留正文 /init");
    await option("/init").click();
    await page.getByText("模拟命令执行失败", { exact: true }).waitFor();
    assert.equal(await field.textContent(), "失败时保留正文 /init");
    await page.evaluate(() => {
      window.slashFixture.fail = false;
    });
    await page
      .getByRole("button", { name: "关闭错误提示", exact: true })
      .click();
    await page.evaluate(() => {
      window.slashFixture.failSubmission = true;
    });
    await type("提交失败时保留正文 /init");
    await option("/init").click();
    await page.getByText("模拟命令执行失败", { exact: true }).waitFor();
    assert.equal(await field.textContent(), "提交失败时保留正文 /init");
    checks.push("目录读取及轮次提交失败恢复完整草稿");

    settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("#zoomLevel");
    await zoom.waitFor();
    for (const theme of ["light", "dark"]) {
      for (const width of [1040, 390]) {
        await page.setViewportSize({ width, height: 780 });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.reload();
          await field.waitFor();
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
          }, theme);
          await type("请先检查项目 /pl");
          await option("/plan").waitFor();
          await page.waitForTimeout(350);
          const bounds = await menu.boundingBox();
          const metrics = await page.evaluate(() => ({
            dpr: devicePixelRatio,
            width: innerWidth,
          }));
          assert.ok(Math.abs(metrics.dpr - scale) < 0.02);
          assert.ok(Math.abs(metrics.width - width / scale) <= 1);
          assert.ok(
            bounds.x >= 0 && bounds.x + bounds.width <= metrics.width + 1,
          );
          layouts.push({ theme, width, scale, bounds, metrics });
          await page.screenshot({
            path: join(output, `${theme}-${width}-${scale}.png`),
          });
          await field.press("Escape");
          if (metrics.width < 768) {
            await page
              .getByRole("button", { name: "显示侧栏", exact: true })
              .click();
            await page
              .getByRole("button", { name: "收起侧栏", exact: true })
              .click();
            await page.locator(".sidebar").waitFor({ state: "hidden" });
          }
        }
      }
    }
    await zoom.selectOption("1");
    assert.equal(await zoom.inputValue(), "1");
    checks.push("深浅主题、桌面及窄屏、80% 至 200% 实际页面缩放与侧栏开关");
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      {
        build: JSON.parse(
          await readFile(join(build, "build-info.json"), "utf8"),
        ),
        data: "隔离浏览器与模拟后端",
        checks,
        layouts,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("PASS", checks);
} finally {
  if (settings)
    await settings
      .locator("#zoomLevel")
      .selectOption("1")
      .catch(() => {});
  await context.close();
  await rm(profile, { recursive: true, force: true });
  server.close();
}
