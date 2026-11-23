import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

function simulateLatency({ backendId, message }) {
  const threadId = backendId === "codex" ? "legacy" : "backend:claude:fixture";
  const items = [
    {
      id: "answer",
      turnId: "fixture-turn",
      type: "agentMessage",
      text: message,
    },
  ];
  return { threadId, codexItems: items, claudeItems: items };
}

function delayRecovery(threadId) {
  localStorage.setItem("cx-current", threadId);
  const auxiliary = [
    "model/list",
    "account/read",
    "config/read",
    "thread/list",
  ];
  const send = WebSocket.prototype.send;
  window.recoveryTrace = [];
  window.recoveryStarted = performance.now();
  WebSocket.prototype.send = function (raw) {
    const { method, params } = JSON.parse(raw);
    const event = {
      method,
      threadId: params?.threadId,
      sentAt: performance.now(),
    };
    window.recoveryTrace.push(event);
    const delay = auxiliary.includes(method)
      ? 850
      : ["thread/read", "thread/items/list"].includes(method)
        ? 180
        : 0;
    setTimeout(() => {
      event.releasedAt = performance.now();
      send.call(this, raw);
    }, delay);
  };
}

const before = process.env.BROWSER_BEFORE === "1";
const build = resolve(process.env.BROWSER_BUILD_DIR || "client/dist");
const output = resolve(
  ".cache/restore-performance",
  before ? "before" : "after",
);
await mkdir(output, { recursive: true });
const serveStatic = createStaticHandler(build);
const server = http.createServer((request, response) => {
  if (serveDemoSession(request, response)) return;
  return serveStatic(
    request,
    response,
    new URL(request.url, "http://fixture").pathname,
  );
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ["--no-proxy-server", "--disable-gpu"],
});
const results = [];
try {
  for (const backendId of ["codex", "claude"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const message =
      backendId === "codex" ? "Codex 历史已恢复" : "Claude Code 历史已恢复";
    const { threadId, ...data } = simulateLatency({ backendId, message });
    await context.addInitScript({
      content: `(${backendFixture.toString()})(${JSON.stringify(data)});(${delayRecovery.toString()})(${JSON.stringify(threadId)});`,
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port, {
      waitUntil: "domcontentloaded",
    });
    await page.getByText(message, { exact: true }).waitFor();
    const measurement = await page.evaluate((threadId) => {
      const events = window.recoveryTrace;
      const request = (method) =>
        events.find((event) => event.method === method);
      const read = events.find(
        (event) =>
          event.method === "thread/read" && event.threadId === threadId,
      );
      const history = events.find(
        (event) =>
          event.method === "thread/items/list" && event.threadId === threadId,
      );
      return {
        firstContentMs: Math.round(performance.now() - window.recoveryStarted),
        metadataPending: request("model/list").releasedAt === undefined,
        sidebarPending: request("thread/list").releasedAt === undefined,
        parallelHistory: history.sentAt < read.releasedAt,
      };
    }, threadId);
    const expected = !before;
    assert.equal(
      measurement.parallelHistory,
      expected,
      JSON.stringify(measurement),
    );
    assert.equal(
      measurement.metadataPending,
      expected,
      JSON.stringify(measurement),
    );
    assert.equal(
      measurement.sidebarPending,
      expected,
      JSON.stringify(measurement),
    );
    await page.screenshot({ path: join(output, backendId + ".png") });
    results.push({ backendId, ...measurement });
    await context.close();
  }
  const stylesheetBytes = (await stat(join(build, "style.css"))).size;
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ stylesheetBytes, results }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ stylesheetBytes, results }));
} finally {
  await browser.close();
  await new Promise((closed) => server.close(closed));
}
