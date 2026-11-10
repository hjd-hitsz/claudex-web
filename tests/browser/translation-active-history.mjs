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

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output = join(
  root,
  ".cache/translation-active-history",
  before ? "before" : "after",
);
const build = before ? join(output, "dist") : join(root, "client/dist");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "translation-active-history-"));
assert.ok(process.env.TRANSLATION_TEST_MODEL_DIR);
const service = createTranslationService({
  configDir: temporary,
  translationModelDir: process.env.TRANSLATION_TEST_MODEL_DIR,
});
await service.setEnabled(true);
for (let attempt = 0; (await service.status()).state !== "ready"; attempt++) {
  assert.ok(attempt < 300, JSON.stringify(await service.status()));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const batches = [];
const translate = createSummaryTranslationHandler((texts) => {
  batches.push(texts);
  return service.translate(texts);
});
const settings = createTranslationSettingsHandler(service);
const thinking = (id, title, status) => ({
  id,
  type: "reasoning",
  turnId: "active-turn",
  summary: [title],
  ...(status && { status }),
});
const data = {
  markdown: "检查运行中的任务",
  turnStartedAt: Math.floor(Date.now() / 1000) - 120,
  activeTurns: { legacy: "active-turn" },
  codexItems: [
    {
      id: "user",
      type: "userMessage",
      turnId: "active-turn",
      content: [{ type: "text", text: "检查配置并继续验证" }],
    },
    thinking("history-one", "Reviewing local configuration"),
    thinking("history-two", "Checking current process state"),
    {
      id: "tool",
      type: "commandExecution",
      turnId: "active-turn",
      command: "pwd",
      status: "completed",
      aggregatedOutput: "/demo/project",
    },
    thinking("streaming", "Preparing isolated test run"),
  ],
  claudeItems: [],
};
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
try {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.locator(".composer .ProseMirror").waitFor();
  await page.locator(".process-history > summary").click();
  const summaries = page.locator(".reasoning-summary");
  await summaries.nth(2).waitFor();
  assert.equal(await summaries.count(), 3);
  if (before) {
    await page.waitForTimeout(1000);
    assert.equal(batches.length, 0);
    assert.match(
      await summaries.nth(0).innerText(),
      /Reviewing local configuration/,
    );
  } else {
    await summaries
      .nth(0)
      .getByRole("button", { name: "查看原文", exact: true })
      .waitFor();
    await summaries
      .nth(1)
      .getByRole("button", { name: "查看原文", exact: true })
      .waitFor();
    assert.ok(batches.flat().includes("Reviewing local configuration"));
    assert.ok(batches.flat().includes("Checking current process state"));
    assert.ok(!batches.flat().includes("Preparing isolated test run"));
    await summaries
      .nth(0)
      .getByRole("button", { name: "查看原文", exact: true })
      .click();
    assert.match(
      await summaries.nth(0).innerText(),
      /Reviewing local configuration/,
    );
    await summaries
      .nth(0)
      .getByRole("button", { name: "查看译文", exact: true })
      .click();
  }
  await page.screenshot({ path: join(output, "active-history.png") });
  await page
    .locator(".process-group")
    .screenshot({ path: join(output, "active-history-details.png") });
  if (!before) {
    const count = batches.length;
    await page.reload();
    await page.locator(".composer .ProseMirror").waitFor();
    await page.locator(".process-history > summary").click();
    await summaries
      .nth(0)
      .getByRole("button", { name: "查看原文", exact: true })
      .waitFor();
    assert.equal(batches.length, count, "刷新后复用当前标签页译文");
    await page.evaluate(
      (item) =>
        window.backendSocket.emit("item/completed", {
          threadId: "legacy",
          turnId: "active-turn",
          item,
        }),
      thinking("streaming", "Preparing isolated test run"),
    );
    await summaries
      .nth(2)
      .getByRole("button", { name: "查看原文", exact: true })
      .waitFor();
    await page.screenshot({ path: join(output, "completed.png") });
    const appearance = await context.newPage();
    await appearance.goto("chrome://settings/appearance");
    const zoom = appearance.locator("#zoomLevel");
    try {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const theme of ["light", "dark"]) {
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
            await zoom.selectOption(String(scale));
            await page.waitForFunction(
              (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
              scale,
            );
            await page.screenshot({
              path: join(output, `${width}-${theme}-${scale}.png`),
            });
            assert.equal(
              await summaries
                .getByRole("button", { name: "查看原文", exact: true })
                .count(),
              3,
            );
          }
        }
      }
    } finally {
      await zoom.selectOption("1");
      await appearance.close();
    }
  }
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      {
        before,
        realCpuTranslation: true,
        build,
        batches,
        text: await summaries.allInnerTexts(),
      },
      null,
      2,
    ),
  );
  console.log(
    before
      ? "PASS 复现中途进入活动会话时历史摘要零翻译请求"
      : "PASS 活动会话历史摘要、真实 CPU 翻译、流式等待、原译文切换、刷新缓存及完成事件",
  );
} finally {
  await context.close();
  await service.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
