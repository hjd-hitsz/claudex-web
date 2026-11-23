import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const output = resolve(
  process.env.BROWSER_OUTPUT_DIR || ".cache/active-turn-recovery/browser",
);
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
const steer = "先核对新输入的边界，再继续规划。";
const newProgress = "正在核对补充要求中的边界。";
const followUp = "再核对窄通道的边界条件。";
const turnId = "legacy-turn";
const request = {
  id: "initial-user",
  turnId,
  type: "userMessage",
  content: [{ type: "text", text: user }],
};
const progress = {
  id: "new-progress",
  type: "agentMessage",
  phase: "commentary",
  text: newProgress,
};

try {
  await context.addInitScript(backendFixture, {
    activeTurns: { legacy: turnId },
    turnStartedAt: Math.floor(Date.now() / 1000) - 12,
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
  const editor = page.locator(".markdown-composer .ProseMirror");
  await editor.fill(steer);
  await editor.press("Control+Enter");
  await page.waitForFunction(
    (turnId) =>
      window.fixtureRequests.some(
        ({ method, params }) =>
          method === "turn/steer" && params.expectedTurnId === turnId,
      ),
    turnId,
  );
  assert.equal(await latest.getByText(prefix + suffix + tail).count(), 1);
  const accepted = {
    ...request,
    id: "accepted-steer",
    content: [{ type: "text", text: steer }],
  };
  await emit("item/started", {
    turnId,
    item: accepted,
    discardedStreamingMessageIds: ["streamed-answer"],
  });
  await emit("item/completed", { turnId, item: accepted });
  await emit("item/completed", {
    turnId,
    item: progress,
  });
  const corrected = page.locator(".process-history");
  await corrected.locator("summary").click();
  await corrected
    .locator(".supplemental-preview")
    .filter({ hasText: steer })
    .waitFor();
  await corrected.getByText(newProgress, { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "interrupted-reply.png") });
  assert.equal(await page.getByText(prefix + suffix + tail).count(), 0);
  assert(await page.locator(".working-status").isVisible());
  const interruptedOffline = "这段正文在网页断开时被打断。";
  const offlineSteer = "重连后继续采用补充条件。";
  await emit("item/agentMessage/delta", {
    turnId,
    itemId: "offline-answer",
    delta: interruptedOffline,
  });
  await latest.getByText(interruptedOffline, { exact: true }).waitFor();
  await page.evaluate(
    ({ request, accepted, progress, turnId, offlineSteer }) => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (raw) {
        const { id, method, params } = JSON.parse(raw);
        if (method !== "thread/items/list" || params.threadId !== "legacy")
          return send.call(this, raw);
        const items = [
          {
            ...request,
            id: "offline-steer",
            content: [{ type: "text", text: offlineSteer }],
          },
          progress,
          accepted,
          request,
        ];
        queueMicrotask(() =>
          this.onmessage({
            data: JSON.stringify({
              id,
              result: {
                data: items.map((item) => ({ turnId, item })),
                streamingMessages: [],
              },
            }),
          }),
        );
      };
      const socket = window.backendSocket;
      socket.readyState = 3;
      socket.onclose();
    },
    { request, accepted, progress, turnId, offlineSteer },
  );
  await page
    .locator(".user-bubble")
    .filter({ hasText: offlineSteer })
    .waitFor();
  await page.screenshot({
    path: join(output, "interrupted-reply-reconnected.png"),
  });
  assert.equal(await page.getByText(interruptedOffline).count(), 0);
  await emit("item/started", {
    turnId,
    item: {
      id: "new-answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "",
    },
  });
  await emit("item/agentMessage/delta", {
    turnId,
    itemId: "new-answer",
    delta: "边界检查完毕。",
  });
  await latest.getByText("边界检查完毕。", { exact: true }).waitFor();
  await emit("item/completed", {
    turnId,
    item: {
      id: "new-answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "边界检查完毕。",
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
    "PASS 流式正文切回恢复、Codex 补充输入后清除中断正文、续跑补充的过程顺序",
  );
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
