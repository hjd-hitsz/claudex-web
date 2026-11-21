import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const output = resolve(".cache/active-turn-recovery/browser");
await mkdir(output, { recursive: true });
const serveStatic = createStaticHandler(
  process.env.BROWSER_BUILD_DIR || resolve("client/dist"),
);
const server = createServer((request, response) => {
  if (serveDemoSession(request, response)) return;
  return serveStatic(
    request,
    response,
    new URL(request.url, "http://fixture").pathname,
  );
});
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-active-turn-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const user = "请继续检查规划器的实现。";
const prefix = "本轮回答从代价公式开始。";
const suffix = "接着检查邻域搜索。";
const tail = "这是切回后产生的新内容。";
const followUp = "再核对窄通道的边界条件。";
const turnId = "legacy-turn";
const request = {
  id: "initial-user",
  turnId,
  type: "userMessage",
  content: [{ type: "text", text: user }],
};

try {
  await context.addInitScript(backendFixture, {
    activeTurns: { legacy: turnId },
    codexItems: [request],
    claudeItems: [],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const latest = page.locator(".message-column > .assistant-message");
  const emit = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.backendSocket.emit(method, params),
      { method, params: { threadId: "legacy", ...params } },
    );
  async function select(title) {
    await page.getByRole("button", { name: /切换对话.*当前为/ }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await page
      .getByRole("button", { name: new RegExp("当前为 " + title + "$") })
      .waitFor();
  }
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.getByText(user, { exact: true }).waitFor();
  await select("客户端未分类");
  await emit("item/agentMessage/delta", {
    turnId,
    itemId: "streamed-answer",
    delta: prefix,
  });
  await page.evaluate(
    ({ request, turnId, prefix, suffix }) => {
      const socket = window.backendSocket;
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const { id, method, params } = JSON.parse(raw);
        if (method !== "thread/items/list" || params.threadId !== "legacy")
          return send(raw);
        const item = {
          id: "streamed-answer",
          turnId,
          type: "agentMessage",
          phase: "final_answer",
        };
        queueMicrotask(() => {
          socket.emit("item/agentMessage/delta", {
            threadId: "legacy",
            turnId,
            itemId: item.id,
            delta: suffix,
          });
          socket.onmessage({
            data: JSON.stringify({
              id,
              result: {
                data: [{ turnId, item: request }],
                ...(params.includeStreaming && {
                  streamingMessages: [{ ...item, text: prefix + suffix }],
                }),
              },
            }),
          });
        });
      };
    },
    { request, turnId, prefix, suffix },
  );
  await select("旧版未分类与 Markdown");
  await page.getByText(prefix + suffix, { exact: true }).waitFor();
  assert(await page.locator(".working-status").isVisible());
  await emit("item/agentMessage/delta", {
    turnId,
    itemId: "streamed-answer",
    delta: tail,
  });
  await latest.getByText(prefix + suffix + tail, { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "streaming-after-switch.png") });
  await emit("item/completed", {
    turnId,
    item: {
      id: "streamed-answer",
      type: "agentMessage",
      phase: "final_answer",
      text: prefix + suffix + tail,
    },
  });
  await emit("turn/completed", { turn: { id: turnId, status: "completed" } });

  const resumed = "background-turn";
  await emit("turn/started", { turn: { id: resumed, status: "inProgress" } });
  await emit("item/completed", {
    turnId: resumed,
    item: {
      id: "task-result",
      type: "functionCallOutput",
      name: "background_completed",
      output: '{"results":[]}',
    },
  });
  await emit("item/completed", {
    turnId: resumed,
    item: {
      id: "initial-progress",
      type: "agentMessage",
      phase: "commentary",
      text: "后台检查已完成，正在复核路径。",
    },
  });
  const process = page
    .locator(".process-history")
    .filter({ hasText: "后台终端正在续跑" });
  await process.locator("summary").first().click();
  await page.locator(".markdown-composer .ProseMirror").fill(followUp);
  await page.locator(".markdown-composer .ProseMirror").press("Control+Enter");
  await page.waitForFunction(
    (turnId) =>
      window.fixtureRequests.some(
        ({ method, params }) =>
          method === "turn/steer" && params.expectedTurnId === turnId,
      ),
    resumed,
  );
  const supplemental = process.locator(".supplemental-preview");
  await supplemental.filter({ hasText: followUp }).waitFor();
  await emit("item/completed", {
    turnId: resumed,
    item: {
      ...request,
      id: "steered-user",
      content: [{ type: "text", text: followUp }],
    },
  });
  await emit("item/completed", {
    turnId: resumed,
    item: {
      id: "follow-up-progress",
      type: "agentMessage",
      phase: "commentary",
      text: "继续验证窄通道的转弯半径。",
    },
  });
  const ordered = await process.locator(".process-content").innerText();
  assert(ordered.indexOf("正在复核路径") < ordered.indexOf(followUp));
  assert(ordered.indexOf(followUp) < ordered.indexOf("转弯半径"));
  assert.equal(await process.locator(".supplemental-preview").count(), 1);
  assert.equal(
    await page.locator(".user-bubble").filter({ hasText: followUp }).count(),
    1,
  );
  await page.screenshot({
    path: join(output, "background-steering-expanded.png"),
  });
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await supplemental.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(output, "background-steering-mobile-dark.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS 进行中正文前缀恢复并衔接增量，续跑补充在过程中的顺序及气泡",
  );
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
