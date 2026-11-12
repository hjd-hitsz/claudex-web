import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { asyncReplies } from "../fixtures/async-replies.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output = join(root, ".cache/async-replies", before ? "before" : "after");
const build =
  process.env.BROWSER_BUILD_DIR ||
  join(root, before ? ".cache/conversation-order/before/dist" : "client/dist");
await mkdir(output, { recursive: true });
const user = (id, text) => ({
  id,
  type: "userMessage",
  content: [{ type: "text", text }],
});
const command = (id) => ({
  id,
  type: "commandExecution",
  command: "npm run check",
  status: "completed",
  aggregatedOutput: "检查完成",
});
let items = [
  user("initial", "请持续检查整个项目。"),
  ...Array.from({ length: 260 }, (_, i) => command("check-" + i)),
  user("steer", "检查通用性，并保留当前工作过程。"),
  asyncReplies[0],
  command("after-reply"),
  user("latest-user", "将约束写入项目指令。"),
  asyncReplies[1],
  { id: "thought", type: "reasoning", summary: ["**继续验证实现**"] },
];
const native = process.env.CONVERSATION_NATIVE_FILE;
if (native) items = JSON.parse(await readFile(native, "utf8")).items;
items = items.map((item) => ({ ...item, turnId: "legacy-turn" }));
const replies = items.filter(
  (item) => item.type === "agentMessage" && item.delivery === "async",
);
assert(replies.length > 0);
const data = {
  activeTurns: { legacy: "legacy-turn" },
  turnStartedAt: Date.now() / 1000 - 3060,
  codexItems: items,
  claudeItems: [],
};
const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response)) return;
  const path = new URL(request.url, "http://fixture").pathname;
  try {
    const body = await readFile(
      join(build, path === "/" ? "index.html" : path),
    );
    response
      .writeHead(200, {
        "Content-Type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[extname(path)] || "text/html",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-async-replies-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
await context.addInitScript(backendFixture, data);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let settings;
const results = [];
const history = page.locator(".process-history");
const outside = page.locator(".message-column > .assistant-message");
async function collapsed() {
  await history.locator(".process-content").waitFor({ state: "detached" });
  assert.equal(await history.count(), 1);
  assert.equal(await outside.count(), 0);
  for (const reply of replies)
    assert.equal(await page.getByText(reply.text, { exact: true }).count(), 0);
}
try {
  await page.goto("http://127.0.0.1:" + server.address().port);
  await history.first().waitFor();
  await page.locator(".markdown-composer .ProseMirror").waitFor();
  if (before) {
    assert.equal(await outside.count(), replies.length);
    assert.equal(await history.count(), 1);
    await page.screenshot({
      path: join(output, native ? "native-exposed.png" : "exposed.png"),
    });
    results.push({
      reproduced: true,
      exposedReplies: replies.length,
      processes: 1,
    });
  } else {
    await collapsed();
    await history.locator("summary").first().click();
    await history.locator(".process-content").waitFor();
    const body = await history.innerText();
    for (const reply of replies)
      assert(body.replace(/\s/g, "").includes(reply.text.replace(/\s/g, "")));
    assert.equal(await outside.count(), 0);
    await page.screenshot({
      path: join(output, native ? "native-expanded.png" : "expanded.png"),
    });
    await history.locator("summary").first().click();
    await collapsed();
    results.push({
      native: Boolean(native),
      items: items.length,
      asyncReplies: replies.length,
      processCount: 1,
      hiddenWhenCollapsed: true,
      visibleWhenExpanded: true,
    });
    if (!native) {
      await history.locator("summary").first().click();
      await history.locator(".process-content").waitFor();
      await page.evaluate(() => {
        window.originalAsyncHistory =
          document.querySelector(".process-history");
      });
      const emit = (method, item) =>
        page.evaluate(
          ({ method, item }) =>
            window.backendSocket.emit(method, {
              threadId: "legacy",
              turnId: "legacy-turn",
              item,
            }),
          { method, item },
        );
      await emit(
        "item/completed",
        user("stream-user", "继续保留原来的汇总区域。"),
      );
      await emit("item/started", {
        ...asyncReplies[0],
        id: "stream-reply",
        text: "",
      });
      await page.evaluate(() =>
        window.backendSocket.emit("item/agentMessage/delta", {
          threadId: "legacy",
          turnId: "legacy-turn",
          itemId: "stream-reply",
          delta: "收到补充，继续工作。",
        }),
      );
      await emit("item/completed", {
        ...asyncReplies[0],
        id: "stream-reply",
        text: "收到补充，继续工作。",
      });
      assert.equal(await history.count(), 1);
      assert.equal(await history.getAttribute("open"), "");
      assert.equal(await outside.count(), 0);
      assert(
        await page.evaluate(
          () =>
            window.originalAsyncHistory ===
            document.querySelector(".process-history"),
        ),
      );
      assert((await history.innerText()).includes("收到补充，继续工作。"));
      await history.locator("summary").first().click();
      await emit("item/completed", command("continued-tool"));
      await page
        .getByText("收到补充，继续工作。", { exact: true })
        .waitFor({ state: "detached" });
      assert.equal(
        await page.getByText("收到补充，继续工作。", { exact: true }).count(),
        0,
      );
      await page.locator(".markdown-composer .ProseMirror").fill("保留草稿");
      await emit("item/completed", {
        id: "real-final",
        type: "agentMessage",
        phase: "final_answer",
        delivery: null,
        text: "全部检查已完成。",
      });
      await page.evaluate(() =>
        window.backendSocket.emit("turn/completed", {
          threadId: "legacy",
          turn: {
            id: "legacy-turn",
            status: "completed",
            completedAt: Date.now() / 1000,
          },
        }),
      );
      await page.locator(".working-status").waitFor({ state: "hidden" });
      assert.equal(await history.count(), 1);
      assert.equal(await outside.count(), 1);
      assert.equal(await outside.innerText(), "全部检查已完成。");
      assert.equal(await page.locator('[aria-label="回复操作"]').count(), 1);
      assert.equal(
        await page.locator(".markdown-composer .ProseMirror").innerText(),
        "保留草稿",
      );
      results.push({
        streamingDeliveryPreserved: true,
        originalProcessPreserved: true,
        realFinalOnly: true,
        draftPreserved: true,
      });
    }
    settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("#zoomLevel");
    await zoom.waitFor();
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.reload();
          await page.locator(".markdown-composer .ProseMirror").waitFor();
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await collapsed();
          const metrics = await page.evaluate(() => ({
            dpr: devicePixelRatio,
            width: innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
          }));
          assert(Math.abs(metrics.dpr - scale) < 0.02);
          assert(Math.abs(metrics.width - width / scale) <= 1);
          assert.equal(metrics.overflow, false);
          if (metrics.width < 768) {
            await page
              .getByRole("button", { name: "显示侧栏", exact: true })
              .click();
            await page
              .getByRole("button", { name: "收起侧栏", exact: true })
              .click();
            await page.locator(".sidebar").waitFor({ state: "hidden" });
          }
          await page.screenshot({
            path: join(
              output,
              `${native ? "native-" : ""}${theme}-${width}-${scale}.png`,
            ),
          });
          results.push({ theme, width, scale, ...metrics });
        }
      }
    }
    await zoom.selectOption("1");
    assert.equal(await zoom.inputValue(), "1");
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, native ? "native-results.json" : "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(JSON.stringify(results));
} finally {
  if (settings)
    await settings
      .locator("#zoomLevel")
      .selectOption("1")
      .catch(() => {});
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
