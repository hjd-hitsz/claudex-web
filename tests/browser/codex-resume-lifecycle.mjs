import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { authenticationFixture } from "../helpers/auth.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output = join(
  root,
  ".cache/codex-resume-lifecycle",
  before ? "before" : "after",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "claudex-resume-browser-"));
const auth = await authenticationFixture(directory);
const backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(backend, "listening");
const thread = {
  id: "resume-demo",
  name: "对话恢复生命周期检查",
  cwd: "/demo/project",
  createdAt: 1,
  status: { type: "idle" },
};
const requests = [];
const user = {
  id: "user",
  type: "userMessage",
  content: [{ type: "text", text: "请说明对话恢复时的处理流程。" }],
};
const answer = {
  id: "answer",
  type: "agentMessage",
  phase: "final_answer",
  text: "历史记录已经加载。打开对话时恢复连接，确认原生线程就绪后可以继续发送消息。",
};
let upstream;
let closing = true;
const closeThread = () => {
  closing = false;
  upstream.send(
    JSON.stringify({
      method: "thread/closed",
      params: { threadId: thread.id },
    }),
  );
};
backend.on("connection", (socket) => {
  upstream = socket;
  socket.on("message", (bytes) => {
    const m = JSON.parse(bytes);
    requests.push(m);
    if (m.id === undefined) return;
    if (m.method === "thread/resume" && closing) {
      socket.send(
        JSON.stringify({
          id: m.id,
          error: {
            code: -32600,
            message: `thread ${thread.id} is closing; retry thread/resume after the thread is closed`,
          },
        }),
      );
      return;
    }
    let result = {};
    if (["thread/list", "thread/search"].includes(m.method))
      result = { data: m.params?.archived ? [] : [thread], nextCursor: null };
    if (["thread/read", "thread/resume"].includes(m.method))
      result = { thread, cwd: thread.cwd, model: "gpt-fixture" };
    if (m.method === "thread/items/list")
      result = {
        data: [answer, user].map((item) => ({ turnId: "turn", item })),
        nextCursor: null,
      };
    if (m.method === "thread/turns/list")
      result = {
        data: [
          {
            id: "turn",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            items: [user, answer],
          },
        ],
        nextCursor: null,
      };
    if (m.method === "model/list")
      result = {
        data: [
          {
            id: "gpt-fixture",
            model: "gpt-fixture",
            displayName: "Codex",
            isDefault: true,
            supportedReasoningEfforts: [],
          },
        ],
      };
    if (m.method === "config/read")
      result = { config: { model: "gpt-fixture" } };
    if (m.method === "account/read") result = { account: null };
    if (
      [
        "skills/list",
        "mcpServerStatus/list",
        "plugin/list",
        "plugin/installed",
      ].includes(m.method)
    )
      result = { data: [] };
    if (m.method === "thread/unsubscribe") result = { status: "unsubscribed" };
    socket.send(JSON.stringify({ id: m.id, result }));
    if (m.method === "thread/unsubscribe") closeThread();
  });
});
let child;
let browser;
try {
  child = spawn(
    process.execPath,
    [
      join(
        root,
        before
          ? ".cache/codex-resume-before/server/src/server.mjs"
          : "server/src/server.mjs",
      ),
    ],
    {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        CODEX_HOME: directory,
        CLAUDE_CONFIG_DIR: join(directory, "claude"),
        CLAUDEX_WEB_CONFIG_DIR: directory,
        STATIC_DIR: join(root, "client/dist"),
        DEFAULT_CWD: thread.cwd,
        CODEX_APP_SERVER_URL: `ws://127.0.0.1:${backend.address().port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stderr.on("data", (b) => (logs += b));
  const url = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`网页服务退出 ${code}\n${logs}`)),
    );
    child.stdout.on("data", (b) => {
      const match = String(b).match(/https:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  const { chromium } = await import(
    pathToFileURL(process.env.PLAYWRIGHT_MODULE)
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies([
    {
      name: "__Host-claudex-web-session",
      value: auth.cookie.split("=")[1],
      url,
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await context.addInitScript(() => {
    localStorage.setItem("cx-current", "resume-demo");
    localStorage.setItem("cx-draft-resume-demo", "保留的输入草稿");
    localStorage.setItem("cx-theme", JSON.stringify("light"));
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByText(answer.text, { exact: true }).waitFor();
  await page
    .getByText(before ? "暂时无法连接此对话" : "正在检查对话状态…", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: join(output, "first-open.png") });
  closeThread();
  if (before)
    await page
      .getByRole("button", { name: "重试连接对话", exact: true })
      .click();
  const input = page.locator(".composer .ProseMirror");
  await input.waitFor();
  assert.equal(await input.innerText(), "保留的输入草稿");
  assert.equal(
    await page.getByText("暂时无法连接此对话", { exact: true }).count(),
    0,
  );
  await page.screenshot({ path: join(output, "ready.png") });
  if (!before) {
    await page.locator('button[title="/demo/project"][aria-expanded]').click();
    for (let cycle = 0; cycle < 3; cycle++) {
      closing = true;
      const previous = requests.filter(
        (m) => m.method === "thread/resume",
      ).length;
      await page
        .locator(".thread-link")
        .filter({ hasText: thread.name })
        .first()
        .click();
      await page.getByText("正在检查对话状态…", { exact: true }).waitFor();
      // 页面事件循环往返确认首次原生错误已经处理，随后交付真实关闭事件。
      await page.waitForTimeout(100);
      assert.equal(
        requests.filter((m) => m.method === "thread/resume").length,
        previous + 1,
      );
      closeThread();
      await input.waitFor();
      assert.equal(await input.innerText(), "保留的输入草稿");
      assert.equal(
        await page.getByText("暂时无法连接此对话", { exact: true }).count(),
        0,
      );
    }
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "dark"),
    );
    await page.screenshot({ path: join(output, "ready-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
    );
    await page.screenshot({ path: join(output, "ready-mobile.png") });
  }
  assert.deepEqual(errors, []);
  const evidence = {
    before,
    data: "isolated simulated app-server with native 0.169 closing error",
    server: before ? "HEAD snapshot" : "working tree",
    frontend: JSON.parse(await readFile(join(root, "build-info.json"), "utf8")),
    browserErrors: errors,
    resumeRequests: requests.filter((m) => m.method === "thread/resume").length,
    manualRetry: before,
    draftPreserved: true,
  };
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  if (child?.exitCode === null) {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  for (const socket of backend.clients) socket.terminate();
  await new Promise((resolve) => backend.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
