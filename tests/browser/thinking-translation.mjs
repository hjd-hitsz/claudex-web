import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { createTranslationService } from "../../server/src/translation-service.mjs";
import {
  createSummaryTranslationHandler,
  createTranslationSettingsHandler,
} from "../../server/src/summary-translation.mjs";
import { createTranslationEngine } from "../../packages/translation-engine/src/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, ".cache/thinking-translation");
const build = process.env.UI_BUILD_DIR || join(root, "client/dist");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(
  join(tmpdir(), "thinking-translation-browser-"),
);
const modelDirectory = process.env.TRANSLATION_TEST_MODEL_DIR;
assert.ok(modelDirectory, "TRANSLATION_TEST_MODEL_DIR 指向已安装的模型目录");
let releaseTranslation;
let hold = true;
const waiting = new Promise((resolve) => {
  releaseTranslation = resolve;
});
const service = createTranslationService(
  { configDir: temporary, translationModelDir: modelDirectory },
  (options) => {
    const engine = createTranslationEngine(options);
    return {
      prepare: () => engine.prepare(),
      async translate(texts) {
        if (hold) await waiting;
        return engine.translate(texts);
      },
      close: () => engine.close(),
    };
  },
);
const batches = [];
const translate = createSummaryTranslationHandler((texts) => {
  batches.push(texts);
  return service.translate(texts);
});
const settings = createTranslationSettingsHandler(service);
const data = { markdown: "Thinking translation fixture", claudeItems: [] };
const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response)) return;
  if (request.url === "/api/translation") return settings(request, response);
  if (request.url === "/api/translate") return translate(request, response);
  try {
    const path = new URL(request.url, "http://fixture").pathname;
    let bytes = await readFile(join(build, path === "/" ? "index.html" : path));
    if (path === "/")
      bytes = bytes
        .toString()
        .replace(
          "<head>",
          `<head><script>(${backendFixture.toString()})(${JSON.stringify(data)})</script>`,
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
      .end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const context = await chromium.launchPersistentContext(
  join(temporary, "browser"),
  {
    executablePath: process.env.CHROME_PATH,
    viewport: { width: 1440, height: 1000 },
    headless: true,
    args: ["--no-sandbox", "--no-proxy-server"],
  },
);
const results = [];
try {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.locator(".composer .ProseMirror").waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const toggle = page.getByRole("checkbox", {
    name: "思考内容翻译",
    exact: true,
  });
  assert.equal(await toggle.isChecked(), false);
  assert.equal(batches.length, 0);
  assert.equal((await service.status()).state, "disabled");
  assert.equal(
    await page.locator(".translation-settings").innerText(),
    "思考内容翻译",
  );
  await toggle.check();
  await page
    .locator(".translation-settings [role=status]")
    .waitFor({ state: "detached" });
  assert.equal(
    await page.locator(".translation-settings").innerText(),
    "思考内容翻译",
  );
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  const item = {
    id: "translation-reasoning",
    type: "reasoning",
    summary: [
      "Reviewing local configuration\nInspecting **application settings** and `runtime_config`. Read [the documentation](https://example.org/guide).",
    ],
  };
  await page.evaluate((item) => {
    const socket = window.backendSocket;
    socket.emit("turn/started", {
      threadId: "legacy",
      turn: { id: "translation-turn", status: "inProgress" },
    });
    socket.emit("item/started", {
      threadId: "legacy",
      turnId: "translation-turn",
      item,
    });
  }, item);
  await page.locator(".reasoning-summary").waitFor();
  await page.locator(".reasoning-summary > summary").click();
  await page.getByText("application settings", { exact: true }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(batches.length, 0);
  await page.evaluate(
    (item) =>
      window.backendSocket.emit("item/completed", {
        threadId: "legacy",
        turnId: "translation-turn",
        item,
      }),
    item,
  );
  for (let attempt = 0; batches.length < 2 && attempt < 100; attempt++)
    await page.waitForTimeout(20);
  assert.ok(batches.length >= 2);
  assert.match(
    await page.locator(".reasoning-summary").innerText(),
    /Reviewing local configuration/,
  );
  assert.match(
    await page.locator(".reasoning-summary").innerText(),
    /application settings/,
  );
  assert.ok(
    batches
      .flat()
      .every(
        (text) =>
          !text.includes("**") &&
          !text.includes("runtime_config") &&
          !text.includes("https://"),
      ),
  );
  await page.screenshot({ path: join(output, "pending-original.png") });
  hold = false;
  releaseTranslation();
  await page.getByRole("button", { name: "查看原文", exact: true }).waitFor();
  await page.waitForFunction(() =>
    /[\u3400-\u9fff]/.test(
      document.querySelector(".reasoning-summary .activity-body .rich-text")
        ?.textContent ||
        document.querySelector(".reasoning-summary .activity-body")
          ?.textContent,
    ),
  );
  await page.getByRole("button", { name: "查看原文", exact: true }).click();
  assert.match(
    await page.locator(".reasoning-summary").innerText(),
    /application settings/,
  );
  await page.getByRole("button", { name: "查看译文", exact: true }).click();
  const translated = await page.locator(".reasoning-summary").innerText();
  assert.match(translated, /runtime_config/);
  assert.equal(
    await page
      .locator('.reasoning-summary a[href="https://example.org/guide"]')
      .count(),
    1,
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await toggle.uncheck();
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  assert.match(
    await page.locator(".reasoning-summary").innerText(),
    /application settings/,
  );
  const appearance = await context.newPage();
  await appearance.goto("chrome://settings/appearance");
  const zoom = appearance.locator("#zoomLevel");
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ["light", "dark"])
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.reload();
          await page.locator(".composer .ProseMirror").waitFor();
          const sidebar = page.getByRole("button", {
            name: "显示侧栏",
            exact: true,
          });
          if (await sidebar.isVisible()) await sidebar.click();
          await page.getByRole("button", { name: "设置", exact: true }).click();
          await page.emulateMedia({ colorScheme: theme });
          await toggle.scrollIntoViewIfNeeded();
          assert.equal(
            await page.locator(".translation-settings").innerText(),
            "思考内容翻译",
          );
          assert.equal(
            await page.locator(".translation-settings details").count(),
            0,
          );
          const metrics = await page
            .locator(".settings-body")
            .evaluate((element) => ({
              width: element.clientWidth,
              scroll: element.scrollWidth,
              dpr: devicePixelRatio,
            }));
          assert.ok(Math.abs(metrics.dpr - scale) < 0.02);
          assert.ok(
            metrics.scroll <= metrics.width + 1,
            JSON.stringify({ width, scale, theme, metrics }),
          );
          results.push({ width, theme, scale, metrics });
          await page.screenshot({
            path: join(output, `${width}-${theme}-${scale}.png`),
          });
          await page
            .getByRole("button", { name: "关闭窗口", exact: true })
            .click();
        }
    }
  } finally {
    await zoom.selectOption("1");
    await appearance.close();
  }
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      { realCpuTranslation: true, batches, translated, results },
      null,
      2,
    ),
  );
  console.log(
    "PASS 默认关闭、完整消息、等待原文、Markdown 文字提取、真实 CPU 翻译、开关及原译文切换、深浅主题与实际页面缩放",
  );
} finally {
  hold = false;
  releaseTranslation();
  await context.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
