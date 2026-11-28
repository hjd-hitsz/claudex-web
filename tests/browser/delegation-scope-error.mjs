import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const scopeError =
  "委派续问失败：原任务范围为 research，本次请求范围为 implementation。请用 implementation 新建委派任务，或改用 research 续问。";
const content = [{ type: "text", text: scopeError }];
const origins = ["claude", "codex", "agy"];
const historicalFailures = [
  {
    type: "dynamicToolCall",
    result: content,
    contentItems: content,
    error: scopeError,
  },
  {
    type: "mcpToolCall",
    status: "completed",
    result: { isError: true, content },
  },
  { type: "mcpToolCall", server: "agy", result: { content } },
].map((failure, index) => ({
  id: origins[index],
  tool: origins[index] + "_delegate",
  status: "failed",
  ...failure,
}));
const proofDir = process.env.DELEGATION_TOOL_PROOF_DIR;
const nativeFailures = proofDir
  ? await Promise.all(
      origins.map(
        async (origin) =>
          JSON.parse(
            await readFile(join(proofDir, origin + "-tools.json"), "utf8"),
          ).failure,
      ),
    )
  : [];
const turnId = "legacy-turn";
const codexItems = [
  {
    id: "fixture-user",
    type: "userMessage",
    content: [{ type: "text", text: "请按原任务续问，并核对工具返回的状态。" }],
  },
  {
    id: "fixture-success",
    type: "mcpToolCall",
    tool: "delegate_task",
    status: "completed",
    result: { content: [{ type: "text", text: "委派任务已受理。" }] },
  },
  ...historicalFailures,
  ...nativeFailures,
  {
    id: "fixture-answer",
    type: "agentMessage",
    phase: "final_answer",
    text: "请在工作过程中查看续问结果。",
  },
].map((item) => ({ ...item, turnId }));
const output = resolve(proofDir || ".cache/delegation-scope-error");
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-delegation-error-"));
const serveStatic = createStaticHandler(resolve("client/dist"));
const server = http.createServer((req, res) => {
  if (serveDemoSession(req, res)) return;
  return serveStatic(req, res, new URL(req.url, "http://fixture").pathname);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH,
    args: ["--disable-gpu", "--no-proxy-server"],
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = context.pages()[0];
  page.setDefaultTimeout(6500);
  await page.addInitScript({
    content: `(${backendFixture})(${JSON.stringify({ codexItems })});
      localStorage.setItem("cx-theme", JSON.stringify("system"));`,
  });
  const settings = await context.newPage();
  await settings.goto("chrome://settings/appearance");
  const zoom = settings.locator("#zoomLevel");
  await page.bringToFront();
  const url = "http://127.0.0.1:" + server.address().port;
  const cards = page.locator(".process-content > .activity");
  const openCard = async (card) => {
    const summary = card.locator(".activity-summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    assert.equal(await summary.getAttribute("aria-expanded"), "true");
    assert(
      await summary.evaluate((button) => button === document.activeElement),
    );
  };
  const layouts = [];
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.goto(url);
        await page.locator(".process-history > summary").click();
        if (width === 390) {
          await page.getByRole("button", { name: "显示侧栏" }).click();
          await page.getByRole("button", { name: "收起侧栏" }).click();
          assert(
            await page.evaluate(
              () =>
                !document
                  .querySelector("#project-sidebar")
                  .contains(document.activeElement),
            ),
          );
        }
        const success = cards.first();
        await openCard(success);
        assert.equal(
          await success
            .locator(".tool-section > small")
            .allTextContents()
            .then((titles) => titles.at(-1)),
          "结果",
        );
        assert.equal(
          await success.getByText("委派任务已受理。", { exact: true }).count(),
          1,
        );
        assert.equal(await success.getByLabel("执行失败").count(), 0);
        const failures = [...historicalFailures, ...nativeFailures];
        for (const [index, failure] of failures.entries()) {
          const card = cards.nth(index + 1);
          await openCard(card);
          assert.equal(await card.getByLabel("执行失败").count(), 1);
          const titles = await card
            .locator(".tool-section > small")
            .allTextContents();
          assert.deepEqual(
            titles,
            failure.arguments ? ["参数", "错误"] : ["错误"],
          );
          const message = card
            .locator(".tool-section-error")
            .getByText(scopeError, { exact: true });
          assert.equal(
            await card.getByText(scopeError, { exact: true }).count(),
            1,
          );
          assert(await message.isVisible());
          if (
            width === 1280 &&
            scale === 1 &&
            index >= (proofDir ? historicalFailures.length : 0)
          ) {
            const origin = origins[index % origins.length];
            await card.screenshot({
              path: join(output, `${origin}-${theme}.png`),
            });
            if (theme === "light" && origin === "claude") {
              await message.evaluate((paragraph) =>
                getSelection().selectAllChildren(paragraph),
              );
              await page.keyboard.press("Control+c");
              assert.equal(
                await page.evaluate(() => navigator.clipboard.readText()),
                scopeError,
              );
            }
          }
        }
        const metrics = await page.evaluate(() => ({
          dpr: devicePixelRatio,
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        assert(Math.abs(metrics.dpr - scale) < 0.02);
        assert(Math.abs(metrics.width - width / scale) <= 1);
        assert(metrics.scroll <= metrics.width + 1);
        layouts.push({ theme, scale, ...metrics });
      }
    }
  }
  await writeFile(
    join(output, "browser.json"),
    JSON.stringify({ layouts, native: Boolean(proofDir) }, null, 2),
  );
  console.log(
    "三端工具卡验证通过：错误只出现一次且可复制，成功结果照常展示，深浅主题和 20 种布局通过。",
  );
} finally {
  await context?.close();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
