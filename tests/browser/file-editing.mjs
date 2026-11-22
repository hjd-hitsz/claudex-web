import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture } from "../fixtures/commands.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.FILE_EDITING_BEFORE === "1";
const build = process.env.BROWSER_BUILD_DIR || join(root, "client/dist");
const output = join(root, ".cache/file-editing", before ? "before" : "after");
await mkdir(output, { recursive: true });
const markdown = [
  "# 可编辑文件预览",
  "",
  "直接修改这段正文。",
  "",
  "行内 HTML <strong>保留强调</strong>。",
  "",
  "## 编辑检查",
  "",
  "### 正文和任务",
  "",
  "> 预览中的正文可直接编辑。",
  "",
  "- 阅读文档",
  "- 核对格式",
  "",
  "- [ ] 检查任务",
  "",
  "| 名称 | 状态 | 平台 | 主题 | 视口 | 缩放 | 环境 | 浏览器 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 预览 | 待编辑 | 桌面 | 明暗 | 窄屏 | 默认 | 测试 | Chromium |",
  "",
  "$x^2$",
  "",
  "$$",
  "y = x + 1",
  "$$",
  "",
  "```js",
  "const value = 1;",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[读取] --> B[保存]",
  "```",
  "",
  "![相对图片](./chart.svg)",
  "",
  "<details><summary>HTML 详情</summary>保留折叠内容。</details>",
  "",
  "<script>window.fileScriptRan=true</script>",
  "",
  "[另一份文件](./other.md)",
  "",
].join("\n");

function fileFixture(markdown) {
  const files = window.commandFixture.files;
  files.set(
    "/fixture/project/README.md",
    sessionStorage.getItem("saved-file") ?? markdown,
  );
  files.set("/fixture/project/other.md", "# 另一份文件");
  files.set(
    "/fixture/project/chart.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#4b9c85"/></svg>',
  );
  window.fileFixture = { fail: false, hold: false, writes: [] };
  const Base = window.WebSocket;
  window.WebSocket = class extends Base {
    send(raw) {
      const request = JSON.parse(raw);
      if (request.method !== "fs/writeFile") return super.send(raw);
      const body = new TextDecoder().decode(
        Uint8Array.from(atob(request.params.dataBase64), (c) =>
          c.charCodeAt(0),
        ),
      );
      window.fileFixture.writes.push({ path: request.params.path, body });
      const finish = () => {
        if (!window.fileFixture.fail) {
          files.set(request.params.path, body);
          sessionStorage.setItem("saved-file", body);
        }
        this.onmessage({
          data: JSON.stringify({
            id: request.id,
            ...(window.fileFixture.fail
              ? { error: { message: "模拟文件保存失败" } }
              : { result: {} }),
          }),
        });
      };
      if (window.fileFixture.hold) window.fileFixture.finish = finish;
      else setTimeout(finish, 0);
    }
  };
}

const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response)) return;
  if (request.url === "/api/translation") {
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ enabled: false }));
    return;
  }
  try {
    const path = new URL(request.url, "http://fixture").pathname;
    const body = await readFile(
      join(build, path === "/" ? "index.html" : path),
    );
    response
      .writeHead(200, {
        "Content-Type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
          }[extname(path)] || "text/html",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-file-editing-"));
const extension = join(profile, "zoom-extension");
await mkdir(extension);
await writeFile(
  join(extension, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "File editing zoom verification",
    version: "1.0",
    permissions: ["tabs"],
    background: { service_worker: "worker.js" },
  }),
);
await writeFile(
  join(extension, "worker.js"),
  "chrome.runtime.onInstalled.addListener(() => {});",
);
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--no-proxy-server",
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
const errors = [];
const metrics = [];
let page;
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(fixture);
  await page.addInitScript(fileFixture, markdown);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(".composer .ProseMirror").waitFor();
  const openFile = async (name) => {
    await page.locator('.context-tools [aria-label="文件"]').click();
    await page.getByRole("button", { name, exact: true }).click();
    await page
      .locator(
        before
          ? ".file-markdown-preview"
          : ".file-markdown-preview .ProseMirror",
      )
      .waitFor();
  };
  await openFile("README.md");
  if (before) {
    assert.equal(
      await page
        .locator('.file-markdown-preview [contenteditable="true"]')
        .count(),
      0,
    );
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        });
        await page.screenshot({ path: join(output, `${theme}-${width}.png`) });
      }
    }
    console.log("PASS 旧构建复现 Markdown 文件预览只读");
  } else {
    const editor = page.locator(".file-markdown-preview .ProseMirror");
    const save = page.getByRole("button", { name: "保存文件", exact: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    const sourceText = async () => {
      await page.locator(".code-editor .cm-content").focus();
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Control+c");
      return page.evaluate(() => navigator.clipboard.readText());
    };
    assert.equal(await save.isDisabled(), true);
    assert.equal(await editor.getAttribute("contenteditable"), "true");
    await editor.locator("h1").filter({ hasText: "可编辑文件预览" }).waitFor();
    await editor.locator("table").waitFor();
    await editor.locator("strong").filter({ hasText: "保留强调" }).waitFor();
    await editor.locator(".katex").first().waitFor();
    await editor.locator(".mermaid-diagram svg").waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".file-markdown-preview img")].some(
        (image) => image.alt === "相对图片" && image.naturalWidth > 0,
      ),
    );
    assert.equal(await page.evaluate(() => window.fileScriptRan), undefined);
    await page
      .getByRole("button", { name: "编辑 Markdown 源码", exact: true })
      .click();
    assert.equal((await sourceText()).trimEnd(), markdown.trimEnd());
    assert.equal(await save.isDisabled(), true);
    await page
      .getByRole("button", { name: "预览 Markdown", exact: true })
      .click();
    await editor.waitFor();
    assert.equal(await save.isDisabled(), true);
    const paragraph = editor
      .locator("p")
      .filter({ hasText: "直接修改这段正文。" })
      .first();
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("预览内新增文字。");
    await page.waitForFunction(() =>
      document.querySelector(".file-status")?.textContent.includes("未保存"),
    );
    await page.keyboard.press("Control+z");
    assert.equal(await paragraph.innerText(), "直接修改这段正文。");
    await page.keyboard.press("Control+Shift+z");
    assert.match(await paragraph.innerText(), /预览内新增文字/);
    await editor.getByRole("checkbox").check();
    const cell = editor.locator("td").filter({ hasText: "待编辑" });
    await cell.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("完成");
    await editor
      .getByRole("button", { name: "编辑代码", exact: true })
      .first()
      .click();
    const code = editor
      .locator(".file-document-code > pre:not([hidden]) code")
      .first();
    await code.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" // 已编辑");
    await editor.getByRole("button", { name: "预览代码", exact: true }).click();
    await page
      .getByRole("button", { name: "编辑 Markdown 源码", exact: true })
      .click();
    const source = await sourceText();
    assert.match(source, /预览内新增文字/);
    assert.match(source, /\[x\] 检查任务/);
    assert.match(source, /待编辑完成/);
    assert.match(source, /const value = 1; \/\/ 已编辑/);
    assert.match(source, /\$x\^2\$/);
    assert.match(source, /\$\$\ny = x \+ 1\n\$\$/);
    assert.match(source, /\.\/chart.svg/);
    assert.match(source, /<details>/);
    await page
      .getByRole("button", { name: "预览 Markdown", exact: true })
      .click();
    await editor.waitFor();
    await editor.locator(".mermaid-diagram svg").waitFor();
    await page.screenshot({ path: join(output, "editing-unsaved.png") });
    await save.click();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="保存文件"]').disabled,
    );
    assert.match(
      await page.evaluate(() =>
        commandFixture.files.get("/fixture/project/README.md"),
      ),
      /预览内新增文字/,
    );
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("提交保存。");
    await page.evaluate(() => (fileFixture.hold = true));
    await save.click();
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("保存期间继续输入。");
    await page.evaluate(() => fileFixture.finish());
    await page.waitForFunction(() =>
      commandFixture.files
        .get("/fixture/project/README.md")
        .includes("提交保存。"),
    );
    assert.equal(await save.isEnabled(), true);
    assert.doesNotMatch(
      await page.evaluate(() =>
        commandFixture.files.get("/fixture/project/README.md"),
      ),
      /保存期间继续输入/,
    );
    await page.evaluate(() => (fileFixture.hold = false));
    await page.keyboard.press("Control+s");
    await page.waitForFunction(
      () => document.querySelector('[aria-label="保存文件"]').disabled,
    );
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("失败后保留。");
    await page.evaluate(() => (fileFixture.fail = true));
    await page.keyboard.press("Control+s");
    await page.getByText("模拟文件保存失败", { exact: true }).waitFor();
    assert.equal(await page.locator(".toast").count(), 0);
    assert.equal(await save.isEnabled(), true);
    assert.match(await editor.innerText(), /失败后保留/);
    await page.screenshot({ path: join(output, "save-failed.png") });
    await page.evaluate(() => (fileFixture.fail = false));
    await page.keyboard.press("Control+s");
    await page.waitForFunction(
      () => document.querySelector('[aria-label="保存文件"]').disabled,
    );
    await page.locator(".error-banner").waitFor({ state: "hidden" });
    await page.screenshot({ path: join(output, "save-recovered.png") });
    await page.waitForFunction(() => !document.querySelector(".toast"));
    await page
      .getByRole("button", { name: "关闭文件面板", exact: true })
      .click();
    await page.locator('.context-tools [aria-label="文件"]').click();
    await editor.waitFor();
    assert.match(await editor.innerText(), /失败后保留/);
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("准备放弃的修改。");
    page.once("dialog", (dialog) => dialog.dismiss());
    await editor.getByRole("link", { name: "另一份文件", exact: true }).click();
    assert.match(await editor.innerText(), /准备放弃的修改/);
    page.once("dialog", (dialog) => dialog.accept());
    await editor.getByRole("link", { name: "另一份文件", exact: true }).click();
    await editor.locator("h1").filter({ hasText: "另一份文件" }).waitFor();
    await page.getByRole("button", { name: "文件列表", exact: true }).click();
    await page.getByRole("button", { name: "README.md", exact: true }).click();
    await editor.waitFor();
    assert.doesNotMatch(await editor.innerText(), /准备放弃的修改/);
    assert.match(await editor.innerText(), /保存期间继续输入/);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        });
        for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
          await worker.evaluate(
            async ({ url, zoom }) => {
              const [tab] = await chrome.tabs.query({ url });
              await chrome.tabs.setZoom(tab.id, zoom);
            },
            { url: page.url(), zoom },
          );
          await save.scrollIntoViewIfNeeded();
          const result = await page.evaluate(() => {
            const rect = document
              .querySelector('[aria-label="保存文件"]')
              .getBoundingClientRect();
            const preview = document.querySelector(".file-markdown-preview");
            const editor = preview.querySelector(".milkdown > .ProseMirror");
            const style = (selector) =>
              getComputedStyle(editor.querySelector(selector));
            const table = editor.querySelector(":scope > table");
            const tableOverflows = table.scrollWidth > table.clientWidth;
            table.scrollLeft = table.scrollWidth;
            const tableScrolls = table.scrollLeft > 0;
            table.scrollLeft = 0;
            return {
              dpr: devicePixelRatio,
              width: innerWidth,
              overflow: document.documentElement.scrollWidth > innerWidth,
              previewOverflow: preview.scrollWidth > preview.clientWidth,
              tableOverflows,
              tableScrolls,
              tableHeadingLines:
                table.querySelector("th p").getBoundingClientRect().height /
                parseFloat(style("th p").lineHeight),
              chapterGap: parseFloat(style("h2").marginBlockStart),
              listGap: parseFloat(style("li + li").marginBlockStart),
              saveVisible:
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                rect.top >= 0 &&
                rect.bottom <= innerHeight,
            };
          });
          assert(Math.abs(result.dpr - zoom) < 0.02);
          assert.equal(result.overflow, false);
          assert.equal(result.previewOverflow, false);
          assert.equal(result.tableScrolls, result.tableOverflows);
          if (width === 390 && zoom === 2) assert(result.tableScrolls);
          assert(result.tableHeadingLines < 1.05);
          assert(result.chapterGap >= 20);
          assert(result.listGap > 0 && result.listGap < result.chapterGap);
          assert.equal(result.saveVisible, true);
          assert.match(await editor.innerText(), /失败后保留/);
          metrics.push({ theme, viewport: width, zoom, ...result });
          if (zoom === 1) {
            await editor.locator(".mermaid-diagram svg").waitFor();
            await page.screenshot({
              path: join(output, `${theme}-${width}.png`),
            });
          }
        }
      }
    }
    assert.deepEqual(errors, []);
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          source: "生产构建、真实 Chromium 编辑器与隔离 WebSocket 文件协议夹具",
          metrics,
          errors,
          images: await page?.locator("img").evaluateAll((images) =>
            images.map((image) => ({
              alt: image.alt,
              src: image.src,
              width: image.naturalWidth,
            })),
          ),
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS 默认预览编辑、撤销、表格、任务、代码、数学语法、相对图片、Mermaid、保存与失败重试，以及深浅主题、窄屏和实际页面缩放",
    );
  }
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") });
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify(
      { errors, text: await page?.locator("body").innerText() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
