import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";

function modelFixture() {
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (raw) {
    const request = JSON.parse(raw);
    if (
      request.method !== "model/list" ||
      request.params.backendId === "claude"
    )
      return send.call(this, raw);
    const data = ["GPT-6.1-Codex", "GPT-6.1-Codex-Extended-Context"].map(
      (displayName, index) => ({
        id: index ? "long" : "gpt",
        model: index ? "long" : "gpt",
        displayName,
        isDefault: !index,
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        defaultReasoningEffort: "high",
        serviceTiers: [{ id: "priority", name: "Fast" }],
      }),
    );
    setTimeout(
      () =>
        this.onmessage({
          data: JSON.stringify({ id: request.id, result: { data } }),
        }),
      0,
    );
  };
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output = join(root, ".cache/model-select", before ? "before" : "after");
const dist = before ? join(output, "dist") : join(root, "client/dist");
await mkdir(output, { recursive: true });
const data = {
  markdown: "模型名称与文件预览布局验证",
  claudeItems: [],
  providers: [
    {
      id: "vendor",
      backendId: "claude",
      name: "示例供应商",
      models: ["team/custom-model"],
      modelAliases: {
        "team/custom-model": "多语言模型自定义显示名称与完整上下文",
      },
    },
  ],
};
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
          `<head><script>(${backendFixture.toString()})(${JSON.stringify(data)});(${modelFixture.toString()})();</script>`,
        );
    response
      .writeHead(200, {
        "Content-Type":
          { ".js": "text/javascript", ".css": "text/css" }[extname(path)] ||
          "text/html",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-model-select-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 800, height: 1100 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const results = [];
const errors = [];
let settings;
try {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.locator(".composer .ProseMirror").waitFor();
  if (before) {
    const metrics = await page
      .locator(".model-select select")
      .evaluate((select) => {
        const style = getComputedStyle(select);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        context.font = style.font;
        return {
          label: select.selectedOptions[0].textContent,
          textWidth: context.measureText(select.selectedOptions[0].textContent)
            .width,
          available:
            select.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight),
        };
      });
    assert(metrics.textWidth > metrics.available, JSON.stringify(metrics));
    results.push(metrics);
    await page.screenshot({ path: join(output, "portrait.png") });
    await page
      .locator(".composer")
      .screenshot({ path: join(output, "portrait-composer.png") });
  } else {
    const select = page.getByRole("combobox", { name: "模型", exact: true });
    await select.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document
        .querySelector(".model-select-value")
        .textContent.includes("Extended"),
    );
    await select.selectOption({ label: "ChatGPT · GPT-6.1-Codex" });
    settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("#zoomLevel");
    await zoom.waitFor();
    const originalZoom = await zoom.inputValue();
    try {
      for (const width of [1440, 800, 390, 320]) {
        await page.setViewportSize({
          width,
          height: width >= 800 ? 1100 : 844,
        });
        for (const scale of width === 320 ? [1] : [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.reload();
          await page.locator(".composer .ProseMirror").waitFor();
          const editor = page.locator(".composer .ProseMirror");
          await editor.fill("输入第一行\n第二行");
          for (const theme of ["light", "dark"]) {
            await page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
            }, theme);
            for (const active of [false, true]) {
              await page.evaluate(
                (active) =>
                  window.backendSocket.emit("lan/state", {
                    ready: true,
                    bridgeReady: true,
                    backends: ["codex", "claude"].map((id) => ({
                      id,
                      type: id,
                      enabled: true,
                      ready: true,
                    })),
                    activeTurns: active ? { legacy: "running" } : {},
                    questions: [],
                    compactions: {},
                    executionStatuses: {},
                    terminals: {},
                  }),
                active,
              );
              for (const name of [
                "GPT-6.1-Codex",
                "GPT-6.1-Codex-Extended-Context",
              ]) {
                await select.selectOption({ label: "ChatGPT · " + name });
                const metrics = await page
                  .locator(".model-select-value")
                  .evaluate((label) => {
                    const select = label.parentElement.querySelector("select");
                    const box = label.getBoundingClientRect();
                    const controls = [
                      ...document.querySelectorAll(
                        ".composer-toolbar button, .composer-toolbar select",
                      ),
                    ].map((node) => {
                      const bounds = node.getBoundingClientRect();
                      return {
                        name: node.getAttribute("aria-label") || node.title,
                        left: bounds.left,
                        right: bounds.right,
                        top: bounds.top,
                        bottom: bounds.bottom,
                      };
                    });
                    const input = document.querySelector(
                      ".document-editor-viewport",
                    );
                    return {
                      label: label.textContent.trim(),
                      selected: select.selectedOptions[0].textContent.trim(),
                      labelWidth: box.width,
                      height: box.height,
                      clientWidth: label.clientWidth,
                      scrollWidth: label.scrollWidth,
                      dpr: devicePixelRatio,
                      viewport: innerWidth,
                      viewportHeight: innerHeight,
                      pageWidth: document.documentElement.scrollWidth,
                      inputHeight: input.clientHeight,
                      lineHeight: parseFloat(
                        getComputedStyle(input.querySelector(".ProseMirror"))
                          .lineHeight,
                      ),
                      controls,
                    };
                  });
                const result = {
                  width,
                  scale,
                  theme,
                  active,
                  name,
                  ...metrics,
                };
                results.push(result);
                assert.equal(metrics.label, metrics.selected);
                assert(
                  metrics.scrollWidth <= metrics.clientWidth + 1,
                  JSON.stringify(result),
                );
                assert(
                  metrics.pageWidth <= metrics.viewport + 1,
                  JSON.stringify(result),
                );
                assert(
                  Math.abs(metrics.dpr - scale) < 0.02,
                  JSON.stringify(result),
                );
                assert(
                  Math.abs(metrics.viewport - width / scale) <= 1,
                  JSON.stringify(result),
                );
                assert(
                  metrics.inputHeight >= metrics.lineHeight * 2 - 2,
                  JSON.stringify(result),
                );
                for (const control of metrics.controls)
                  assert(
                    control.left >= -1 &&
                      control.right <= metrics.viewport + 1 &&
                      control.top >= 0 &&
                      control.bottom <= metrics.viewportHeight + 1,
                    JSON.stringify({ ...result, control }),
                  );
                if (scale === 1 && active)
                  await page.screenshot({
                    path: join(output, `${width}-${theme}-${name}.png`),
                  });
                if (
                  width === 800 &&
                  scale === 1 &&
                  active &&
                  name === "GPT-6.1-Codex"
                )
                  await page.locator(".composer").screenshot({
                    path: join(output, `portrait-composer-${theme}.png`),
                  });
              }
            }
          }
          if (
            await page
              .getByRole("button", { name: "显示侧栏", exact: true })
              .isVisible()
          ) {
            await page
              .getByRole("button", { name: "显示侧栏", exact: true })
              .click();
            const close = page.getByRole("button", {
              name: "收起侧栏",
              exact: true,
            });
            await close.click();
            await page.locator(".sidebar").waitFor({ state: "hidden" });
            assert.equal(
              await page
                .locator(".sidebar")
                .evaluate((node) => getComputedStyle(node).visibility),
              "hidden",
            );
          }
        }
      }
    } finally {
      await zoom.selectOption(originalZoom);
      assert.equal(await zoom.inputValue(), originalZoom);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.reload();
    await page.locator(".composer .ProseMirror").waitFor();
    await page
      .getByRole("button", { name: /^新对话/ })
      .first()
      .click();
    const alias = "示例供应商 · 多语言模型自定义显示名称与完整上下文";
    await select.selectOption({ label: alias });
    assert.equal(await page.locator(".model-select-value").innerText(), alias);
    assert.equal(JSON.parse(await select.inputValue())[2], "team/custom-model");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".sidebar").waitFor({ state: "hidden" });
    const aliasFits = await page
      .locator(".model-select-value")
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
    assert(aliasFits);
    await page.screenshot({ path: join(output, "provider-alias.png") });
    await select.focus();
    assert.equal(
      await page
        .locator(".model-select")
        .evaluate((node) => getComputedStyle(node).outlineStyle),
      "solid",
    );
    assert.deepEqual(errors, []);
  }
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        before,
        build: JSON.parse(
          await readFile(
            join(before ? output : root, "build-info.json"),
            "utf8",
          ),
        ),
        data: "隔离 Codex 与 Claude 模型目录、供应商别名及模拟后端；独立浏览器配置",
        modelTurns: 0,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    before
      ? "PASS 复现竖屏模型名截断"
      : `PASS ${results.length} 组模型名、窄屏、实际缩放、深浅主题及运行状态布局`,
  );
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
