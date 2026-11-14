import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { testBrowserZoom } from "./browser-zoom.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output = join(root, ".cache/message-images", before ? "before" : "after");
const build = before ? join(output, "dist") : join(root, "client/dist");
await mkdir(output, { recursive: true });
const landscape = (
  await readFile(join(root, "docs/images/desktop-light.png"))
).toString("base64");
const portrait = (
  await readFile(join(root, "docs/images/mobile.png"))
).toString("base64");
const markdown = [
  "图片展示回归，检查图内文字、居中位置与正文衔接。",
  "![横向图表](./landscape.png)",
  "后续正文保持正常阅读。",
  "[![链接图片](./landscape.png)](https://example.org)",
  '<picture><source srcset="./landscape.png"><img src="./portrait.png" alt="响应式图片"></picture>',
  "![纵向图片](./portrait.png)",
  '<img src="./landscape.png" alt="指定宽度" width="88">',
  "[notes.md](./notes.md)",
].join("\n\n");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response)) return;
  try {
    const path = new URL(request.url, "http://fixture").pathname;
    const body = await readFile(
      join(build, path === "/" ? "index.html" : path),
    );
    response
      .writeHead(200, { "Content-Type": mime[extname(path)] || "text/html" })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-message-images-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"],
});
const records = [];
let settings, page;
try {
  const fixtureData = {
    main: true,
    codexItems: [
      {
        id: "images-answer",
        type: "agentMessage",
        turnId: "legacy-turn",
        phase: "final_answer",
        text: markdown,
      },
    ],
    claudeItems: [],
  };
  const resolveFiles = ({ landscape, portrait, markdown }) => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (raw) {
      const request = JSON.parse(raw);
      if (request.method !== "fs/readFile") return send.call(this, raw);
      const path = request.params.path;
      const dataBase64 = path.endsWith("notes.md")
        ? btoa(unescape(encodeURIComponent(markdown)))
        : path.endsWith("portrait.png")
          ? portrait
          : landscape;
      setTimeout(
        () =>
          this.onmessage({
            data: JSON.stringify({
              id: request.id,
              result: { dataBase64 },
            }),
          }),
        0,
      );
    };
  };
  await context.addInitScript({
    content: `(${backendFixture})(${JSON.stringify(fixtureData)}); (${resolveFiles})(${JSON.stringify({ landscape, portrait, markdown })});`,
  });
  page = await context.newPage();
  page.on("pageerror", (error) => console.error(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(".assistant-message img").first().waitFor();
  console.log("图片夹具已加载");
  settings = await context.newPage();
  await settings.goto("chrome://settings/appearance");
  const zoom = settings.locator("#zoomLevel");
  await zoom.waitFor();
  console.log("浏览器缩放设置已加载");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
      console.log(`检查 ${width}px ${scale * 100}%`);
      await zoom.selectOption(String(scale));
      await page.reload();
      await page.locator(".markdown-composer .ProseMirror").waitFor();
      await page.locator(".assistant-message img").first().waitFor();
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        );
        for (const selector of [
          ".assistant-message",
          ".file-markdown-preview",
        ]) {
          if (selector === ".assistant-message") {
            const close = page.getByRole("button", {
              name: "收起对话详情",
              exact: true,
            });
            if (await close.isVisible()) await close.press("Enter");
          } else {
            await page
              .getByRole("link", { name: "notes.md", exact: true })
              .click();
            await page.locator(".file-markdown-preview img").first().waitFor();
          }
          const images = page.locator(`${selector} .message-image-button`);
          assert.equal(await images.count(), 5);
          for (let index = 0; index < 5; index++) {
            const button = images.nth(index);
            await button.evaluate((element) =>
              element.scrollIntoView({ block: "center", behavior: "instant" }),
            );
            await page.waitForFunction(
              (element) => element.complete && element.naturalWidth > 0,
              await button.locator("img").elementHandle(),
              { timeout: 10000 },
            );
            const metrics = await button.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const parent = element.parentElement.getBoundingClientRect();
              const image = element.querySelector("img");
              const rect = image.getBoundingClientRect();
              return {
                width: box.width,
                height: box.height,
                centerOffset:
                  box.left + box.width / 2 - parent.left - parent.width / 2,
                available: parent.width,
                ratio: rect.width / rect.height,
                naturalRatio: image.naturalWidth / image.naturalHeight,
                dpr: devicePixelRatio,
                viewport: innerWidth,
                overflow: document.documentElement.scrollWidth > innerWidth,
              };
            });
            records.push({ width, scale, theme, selector, index, ...metrics });
            assert.ok(Math.abs(metrics.dpr - scale) < 0.02);
            assert.ok(Math.abs(metrics.viewport - width / scale) <= 1);
            assert.equal(metrics.overflow, false);
            assert.ok(metrics.width <= metrics.available + 1);
            assert.ok(Math.abs(metrics.ratio - metrics.naturalRatio) < 0.02);
            if (before) {
              assert.ok(metrics.width <= 320);
            } else {
              assert.ok(
                Math.abs(metrics.centerOffset) < 1,
                JSON.stringify(records.at(-1)),
              );
              assert.ok(
                metrics.width <= 641 && metrics.height <= 483,
                JSON.stringify(records.at(-1)),
              );
              if (index === 4)
                assert.ok(
                  Math.abs(metrics.width - Math.min(90, metrics.available)) < 1,
                  JSON.stringify(records.at(-1)),
                );
              if (index < 3 && metrics.available >= 640)
                assert.ok(metrics.width >= 639);
            }
          }
          await images
            .first()
            .evaluate((element) =>
              element.scrollIntoView({ block: "center", behavior: "instant" }),
            );
          if (scale === 1)
            await page.screenshot({
              path: join(output, `${width}-${theme}-${selector.slice(1)}.png`),
            });
        }
      }
      const button = page
        .locator(".file-markdown-preview .message-image-button")
        .first();
      await button.click();
      await page.locator(".image-viewer[open] img").waitFor();
      await page.getByRole("button", { name: "原始尺寸", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.locator(".image-viewer").waitFor({ state: "detached" });
      assert.equal(await page.locator(".image-viewer").count(), 0);
      assert.equal(
        await button.evaluate((element) => element === document.activeElement),
        true,
      );
    }
  }
  if (!before)
    await testBrowserZoom({ context, page, artifacts: join(output, "zoom") });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        build: JSON.parse(
          await readFile(
            join(before ? output : root, "build-info.json"),
            "utf8",
          ),
        ),
        data: "仓库截图与隔离消息，模拟后端，独立 Chromium 配置，模型调用为零",
        records,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS ${before ? "复现 320px 图片" : "图片居中与放大"}、消息和文件预览、深浅主题、窄屏、80%–200% 实际缩放、大图与焦点恢复`,
  );
} catch (error) {
  console.error(
    await page?.evaluate(() => ({
      text: document.body.innerText,
      requests: window.fixtureRequests,
      images: [...document.querySelectorAll(".markdown img")].map((image) => ({
        alt: image.alt,
        loaded: image.complete,
        width: image.naturalWidth,
        src: image.src.slice(0, 40),
        bounds: image.getBoundingClientRect().toJSON(),
      })),
    })),
  );
  await page?.screenshot({ path: join(output, "failure.png") });
  throw error;
} finally {
  if (settings) await settings.locator("#zoomLevel").selectOption("1");
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
