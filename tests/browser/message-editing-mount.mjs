import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { messageEditingFixture } from "../fixtures/message-editing.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.EDIT_MOUNT_BEFORE === "1";
const output = join(
  root,
  ".cache/message-editing-mount",
  before ? "before" : "after",
);
const build = before ? join(output, "dist") : join(root, "client/dist");
const text =
  "[planner.py](/demo/project/planner.py) 介绍一下这个文件的代码流程";
const turns = [
  {
    id: "last",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    items: [
      {
        id: "last-user",
        type: "userMessage",
        content: [{ type: "text", text }],
      },
      {
        id: "last-answer",
        type: "agentMessage",
        phase: "final_answer",
        text: "规划流程说明",
      },
    ],
  },
];
await mkdir(output, { recursive: true });
const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response)) return;
  try {
    const path = new URL(request.url, "http://fixture").pathname;
    let body = await readFile(join(build, path === "/" ? "index.html" : path));
    if (path === "/")
      body = body
        .toString()
        .replace(
          "<head>",
          `<head><script>if(!sessionStorage.getItem('edit-turns'))sessionStorage.setItem('edit-turns',${JSON.stringify(JSON.stringify(turns))});(${messageEditingFixture.toString()})()</script>`,
        );
    response
      .writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[path === "/" ? ".html" : extname(path)] ||
          "application/octet-stream",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "message-editing-mount-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const errors = [],
  results = [];
let settings;
try {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.stack));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /ResizeObserver|offsetHeight/.test(message.text())
    )
      errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const composer = page.locator(".composer .ProseMirror");
  await composer.waitFor();
  await composer.fill("底部独立草稿");
  // 持久高度偏好仅作用于底部输入区，原位编辑继续保持两行。
  await page.evaluate(() => localStorage.setItem("cx-composer-height", "0.65"));
  const edit = page.getByRole("button", {
    name: "编辑上一条消息",
    exact: true,
  });
  await edit.click();
  if (before) {
    await page.getByRole("heading", { name: "页面遇到错误" }).waitFor();
    await page.screenshot({ path: join(output, "page-error.png") });
    assert.match(errors.join("\n"), /ResizeObserver|offsetHeight/);
    results.push({ reproduced: true, error: errors });
  } else {
    const form = page.getByRole("form", { name: "编辑上一条消息" });
    const editor = form.locator(".ProseMirror");
    await editor.waitFor();
    assert.equal(await form.locator(".composer-resizer").count(), 0);
    assert.equal(await editor.locator("[data-inline-reference]").count(), 1);
    assert.match(await editor.innerText(), /planner.py\s+介绍一下/);
    assert.equal(await composer.innerText(), "底部独立草稿");
    await form.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await form.count(), 0);
    assert.equal(
      await page.getByText("规划流程说明", { exact: true }).count(),
      1,
    );
    await edit.click();
    await editor.waitFor();
    settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("#zoomLevel");
    await zoom.waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.waitForFunction(
            (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
            scale,
          );
          await editor.fill(
            Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行编辑正文`).join(
              "\n",
            ),
          );
          await form.scrollIntoViewIfNeeded();
          const metrics = await form.evaluate((node) => {
            const viewport = node.querySelector(".document-editor-viewport");
            const box = node.getBoundingClientRect();
            return {
              dpr: devicePixelRatio,
              innerWidth,
              cssZoom: getComputedStyle(document.documentElement).zoom,
              lines:
                viewport.clientHeight /
                parseFloat(getComputedStyle(viewport).lineHeight),
              scrollHeight: viewport.scrollHeight,
              clientHeight: viewport.clientHeight,
              left: box.left,
              right: box.right,
              width: box.width,
              maxWidth:
                42 *
                parseFloat(getComputedStyle(document.documentElement).fontSize),
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          results.push({ width, theme, scale, ...metrics });
          assert.equal(metrics.cssZoom, "1");
          assert.ok(Math.abs(metrics.innerWidth - width / scale) <= 1);
          assert.ok(Math.abs(metrics.lines - 2) < 0.1, JSON.stringify(metrics));
          assert.ok(metrics.scrollHeight > metrics.clientHeight);
          assert.ok(metrics.width <= metrics.maxWidth + 1);
          assert.ok(
            metrics.left >= 0 && metrics.right <= metrics.innerWidth + 1,
          );
          assert.equal(metrics.overflow, false);
          assert.equal(await composer.innerText(), "底部独立草稿");
          await page.screenshot({
            path: join(output, `${width}-${theme}-${scale}.png`),
          });
        }
      }
    }
    await zoom.selectOption("1");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await form.getByRole("button", { name: "取消", exact: true }).click();
    await edit.click();
    await editor.waitFor();
    await page.screenshot({ path: join(output, "reference-editor.png") });
    await editor.press("Control+End");
    await page.keyboard.insertText("，补充输入与输出 ");
    const code = "def prepare_route(inputs):";
    const location = { path: "/demo/project/planner.py", line: 12 };
    await page.evaluate(() => (editFixture.holdCodeLookup = true));
    await editor.evaluate((element, code) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", code + "\n");
      clipboardData.setData(
        "vscode-editor-data",
        JSON.stringify({ mode: "python", isFromEmptySelection: true }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, code);
    await editor.press("Control+Enter");
    await form.getByRole("button", { name: "匹配文件…" }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        editFixture.requests.some(
          (r) => r.method === "thread/revert" || r.method === "turn/start",
        ),
      ),
      false,
    );
    await page.screenshot({ path: join(output, "edit-waiting-for-match.png") });
    await page.evaluate(
      (location) => editFixture.finishCodeLookup([location]),
      location,
    );
    await page.getByText("修改后的回答", { exact: true }).waitFor();
    const sent = await page.evaluate(
      () =>
        editFixture.requests.filter((r) => r.method === "turn/start").at(-1)
          .params.input,
    );
    assert.match(
      sent[0].text,
      /\[planner\.py\]\(\/demo\/project\/planner\.py\)/,
    );
    assert.match(sent[0].text, /补充输入与输出/);
    assert(
      sent.some(({ text }) =>
        text?.includes(`\n- ${location.path}:${location.line}\n`),
      ),
    );
    assert.equal(await composer.innerText(), "底部独立草稿");
    await page.reload();
    await page.getByText("修改后的回答", { exact: true }).waitFor();
    await edit.click();
    await editor.waitFor();
    assert.equal(await editor.locator("[data-inline-reference]").count(), 1);
    assert.match(await editor.innerText(), /补充输入与输出/);
    await editor.press("Escape");
    assert.equal(await form.count(), 0);
    assert.deepEqual(errors, []);
  }
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      {
        passed: true,
        before,
        results,
        errors,
        build: JSON.parse(
          await readFile(
            before
              ? join(output, "build-info.json")
              : join(root, "build-info.json"),
            "utf8",
          ),
        ),
        data: "隔离模拟历史；单条用户消息含 planner.py Markdown 文件引用；真实 Chromium 编辑器",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, output, before }));
} finally {
  if (settings) await settings.locator("#zoomLevel").selectOption("1");
  await context.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}
