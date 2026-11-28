import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, on } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { authenticationFixture } from "../helpers/auth.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";

const before = Boolean(process.env.CLAUDE_COMPACTION_BEFORE_ROOT);
const project = resolve(process.env.CLAUDE_COMPACTION_BEFORE_ROOT || ".");
const fromProject = (path) => import(pathToFileURL(join(project, path)));
const { createWebApplication } = await fromProject(
  "server/src/application.mjs",
);
const { createAuthentication } = await fromProject("server/src/auth.mjs");
const { readConfig } = await fromProject("server/src/config.mjs");
const { createBackendConfiguration } = await fromProject(
  "server/src/backends/configuration.mjs",
);
const { createProviders } = await fromProject(
  "server/src/backends/providers.mjs",
);
const { createClaudeWorkerAdapter } = await fromProject(
  "server/src/backends/claude/worker-client.mjs",
);
const { workerLocation } = await fromProject(
  "server/src/backends/claude/worker-location.mjs",
);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const root = await mkdtemp(join(tmpdir(), "claudex-claude-compact-"));
const output = resolve(".cache/claude-compaction", before ? "before" : "after");
const cwd = join(root, "workspace");
const bin = join(root, "bin");
await Promise.all(
  [cwd, bin, output].map((dir) => mkdir(dir, { recursive: true })),
);
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
Object.assign(process.env, {
  PATH: `${bin}:${process.env.PATH}`,
  XDG_RUNTIME_DIR: root,
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "65",
});
delete process.env.DBUS_SESSION_BUS_ADDRESS;

const questions = [
  "检查压缩前的工作区记录",
  "整理前再确认一次",
  "整理后继续核对第一项",
  "整理后继续核对第二项",
  "增加上下文占用以触发自动整理",
  "触发自动整理后继续核对",
  "自动整理后追加新问题",
];
const answers = [
  "压缩前的工具记录已保留。",
  "压缩前第二轮已完成。",
  "压缩后第一轮已完成。",
  "压缩后第二轮已完成。",
  "已记录较高的上下文占用。",
  "自动整理轮次已继续作答。",
  "自动整理后的下一轮已完成。",
];
const childPrompt = "ISOLATED_CHILD_TASK";
const childAnswer = "隔离子代理已返回结果。";
const childReceipt = "主代理已收到子代理结果。";
const expectedReplies = [answers[0], childReceipt, ...answers.slice(1, 4)];
const automaticSummary = "仅用于自动整理的隔离摘要。";
const toolId = "toolu_claudex_compaction_child";
let phase = 0;
const pendingSummary = Promise.withResolvers();
const receivedSummary = Promise.withResolvers();
const model = await messagesServer(async (body) => {
  const all = JSON.stringify(body.messages);
  const last = JSON.stringify(body.messages.at(-1));
  if (last.includes("<task-notification>"))
    return [{ type: "text", text: childReceipt }];
  if (all.includes(childPrompt) && !all.includes(toolId))
    return [{ type: "text", text: childAnswer }];
  if (
    phase === 0 &&
    last.includes(questions[0]) &&
    body.tools?.some(({ name }) => name === "Agent")
  )
    return [
      {
        type: "tool_use",
        name: "Agent",
        id: toolId,
        input: { description: "核对隔离记录", prompt: childPrompt },
      },
    ];
  if (phase === -1) {
    receivedSummary.resolve();
    await pendingSummary.promise;
    return [{ type: "text", text: "用于续接的隔离整理摘要。" }];
  }
  if (phase === 4)
    return {
      content: [{ type: "text", text: answers[phase] }],
      usage: { input_tokens: 95000 },
    };
  if (phase === 5 && last.includes("Do NOT call any tools."))
    return [{ type: "text", text: automaticSummary }];
  return [{ type: "text", text: answers[phase] }];
});
const config = readConfig({
  CLAUDEX_WEB_CONFIG_DIR: root,
  DEFAULT_CWD: cwd,
  CODEX_HOME: join(root, "codex"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  HOST: "127.0.0.1",
  PORT: "0",
});
const settings = createBackendConfiguration(config);
for (const id of ["codex", "claude", "agy"])
  await settings.save({
    id,
    type: id,
    enabled: id === "claude",
    ...(id === "claude" && { proxy: { mode: "off" } }),
  });
const backend = (await settings.read()).backends.find(
  ({ id }) => id === "claude",
);
await createProviders(settings).save({
  id: "fixture",
  backendId: "claude",
  name: "隔离模型",
  protocol: "messages_compatible",
  baseUrl: model.url,
  apiKey: "fixture-token",
  models: ["fixture-model"],
  modelCapabilities: {
    "fixture-model": { contextWindow: 100000, supportedEffortLevels: [] },
  },
});
const auth = await authenticationFixture(root);
const app = createWebApplication({
  config,
  tls: auth.tls,
  authentication: await createAuthentication(config),
  version: { version: "4.2.3", displayVersion: "4.2.3" },
});

let context;
try {
  await app.start();
  const url = `https://127.0.0.1:${app.server.address().port}`;
  context = await chromium.launchPersistentContext(join(root, "browser"), {
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 920 },
  });
  await context.addCookies([
    {
      name: "__Host-claudex-web-session",
      value: auth.cookie.split("=")[1],
      url,
      httpOnly: true,
    },
  ]);
  await context.addInitScript(() => {
    localStorage.setItem("cx-backend", JSON.stringify("claude"));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const events = [];
  const packets = new EventEmitter();
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const packet = JSON.parse(payload);
      if (packet.method) {
        events.push(packet);
        packets.emit(packet.method, packet.params);
      }
    }),
  );
  await page.goto(url);
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  const screenshot = (name) =>
    page.screenshot({ path: join(output, name + ".png") });
  await composer.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('select[aria-label="模型"] option')].some(
      (option) => option.textContent.includes("fixture-model"),
    ),
  );
  const threadId = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`wss://${location.host}/rpc`);
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              id: 1,
              method: "thread/start",
              params: {
                backendId: "claude",
                providerId: "fixture",
                model: "fixture-model",
                delegationMode: true,
              },
            }),
          );
        socket.onerror = reject;
        socket.onmessage = ({ data }) => {
          const packet = JSON.parse(data);
          if (packet.id !== 1) return;
          socket.close();
          if (packet.error) reject(new Error(packet.error.message));
          else {
            const id = packet.result.thread.id;
            localStorage.setItem("cx-current", id);
            resolve(id);
          }
        };
      }),
  );
  await page.reload();
  const answerNodes = page.locator(".message-column > .assistant-message");
  const completions = () =>
    events.filter(
      ({ method, params }) =>
        method === "turn/completed" && params.threadId === threadId,
    );
  async function completed(predicate) {
    const existing = completions().find(({ params }) => predicate(params.turn));
    if (existing) return existing.params.turn;
    for await (const [params] of on(packets, "turn/completed", {
      signal: AbortSignal.timeout(15000),
    }))
      if (params.threadId === threadId && predicate(params.turn))
        return params.turn;
  }
  const ask = async (index) => {
    phase = index;
    await composer.fill(questions[index]);
    await send.click();
    await answerNodes.getByText(answers[index], { exact: true }).waitFor();
    const turn = await completed((turn) =>
      turn.items.some(
        (item) =>
          item.type === "userMessage" &&
          item.content.some(({ text }) => text === questions[index]),
      ),
    );
    assert.equal(turn.status, "completed");
    return turn;
  };
  await ask(0);
  await answerNodes.getByText(childReceipt, { exact: true }).waitFor();
  await completed((turn) => turn.automatic);
  await ask(1);
  await screenshot("before-command");

  phase = -1;
  await composer.fill("/compact");
  await send.click();
  await page.locator(".compaction-status.running").waitFor();
  await Promise.race([
    receivedSummary.promise,
    page.waitForTimeout(10000).then(() => {
      throw new Error("Claude 未调用隔离整理端点");
    }),
  ]);
  await screenshot("command-running");
  pendingSummary.resolve();
  await page.locator(".compaction-status.completed").waitFor();
  const compaction = await completed((turn) =>
    turn.items.some(({ type }) => type === "contextCompaction"),
  );
  assert.equal(
    compaction.items.filter(({ type }) => type === "contextCompaction").length,
    1,
  );
  const ghosts = () =>
    events.filter(
      ({ method, params }) =>
        method === "item/completed" &&
        params.turnId === compaction.id &&
        params.item.type === "subAgentActivity" &&
        params.item.agentPath === "claudex-secretary",
    );
  assert.equal(ghosts().length > 0, before);
  await ask(2);
  await ask(3);
  assert.deepEqual(await answerNodes.allTextContents(), expectedReplies);
  await screenshot("live-followups");

  await page.reload();
  await answerNodes.getByText(answers[3], { exact: true }).waitFor();
  const afterReload = await answerNodes.allTextContents();
  const processes = page.locator(".message-column .process-history");
  for (const process of await processes.all())
    await process.locator("summary").first().click();
  await page.getByRole("button", { name: "整理上下文", exact: true }).waitFor();
  await screenshot("reloaded-desktop");
  const recoveredGhost = page.getByRole("button", {
    name: /子代理完成.*claudex-secretary/,
  });
  let automatic;
  if (before) {
    assert.notDeepEqual(afterReload, expectedReplies);
    await recoveredGhost.first().waitFor();
    await recoveredGhost.first().click();
    await page
      .getByText(/Claude 原生会话记录不存在/)
      .first()
      .waitFor();
    await screenshot("ghost-drawer");
  } else {
    assert.deepEqual(afterReload, expectedReplies);
    assert.equal(await recoveredGhost.count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "整理上下文", exact: true })
        .count(),
      1,
    );
    const child = page.getByRole("button", {
      name: /子代理完成.*核对隔离记录/,
    });
    await child.click();
    await page.getByText(childAnswer, { exact: true }).waitFor();
    await screenshot("real-subagent");
    await page.getByRole("button", { name: "返回概览", exact: true }).click();

    const browser = await context.newPage();
    await browser.goto("chrome://settings/appearance");
    const zoom = browser.locator("#zoomLevel");
    for (const width of [1400, 390]) {
      await page.setViewportSize({ width, height: 920 });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.waitForFunction(
            ({ width, scale }) =>
              Math.abs(devicePixelRatio - scale) < 0.02 &&
              Math.abs(innerWidth - width / scale) <= 1 &&
              document.documentElement.scrollWidth <= innerWidth + 1,
            { width, scale },
          );
          assert.deepEqual(
            await answerNodes.allTextContents(),
            expectedReplies,
          );
        }
        await zoom.selectOption("1");
        if (width === 390) await screenshot(`reloaded-mobile-${colorScheme}`);
      }
    }
    await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
    const closeSidebar = page.getByRole("button", {
      name: "收起侧栏",
      exact: true,
    });
    await closeSidebar.focus();
    await screenshot("reloaded-mobile-sidebar");
    await closeSidebar.press("Enter");
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#project-sidebar")
          .contains(document.activeElement),
    );
    await browser.close();
    await page.setViewportSize({ width: 1400, height: 920 });
    await page.emulateMedia({ colorScheme: "light" });
    await ask(4);
    const autoTurn = await ask(5);
    const autoMarker = autoTurn.items.find(
      ({ type }) => type === "contextCompaction",
    );
    assert(autoMarker, "实际 Claude CLI 在续接轮次中发出自动整理标记");
    assert(
      !events.some(
        ({ method, params }) =>
          method === "item/completed" &&
          params.turnId === autoTurn.id &&
          params.item.type === "subAgentActivity",
      ),
    );
    await ask(6);
    await page.reload();
    await answerNodes.getByText(answers[6], { exact: true }).waitFor();
    const automaticReplies = await answerNodes.allTextContents();
    assert.deepEqual(automaticReplies, [
      ...expectedReplies,
      ...answers.slice(4),
    ]);
    assert.equal(
      await page.getByText(automaticSummary, { exact: true }).count(),
      0,
    );
    await processes.last().locator("summary").first().click();
    await processes
      .last()
      .getByRole("button", { name: "整理上下文" })
      .waitFor();
    await screenshot("automatic-continued");
    automatic = { replies: automaticReplies, markerInAnswerTurn: true };
  }
  const evidence = {
    before,
    cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
    streamedAnswers: answers.filter((answer) =>
      events.some(
        ({ method, params }) =>
          method === "item/agentMessage/delta" && answer.includes(params.delta),
      ),
    ).length,
    completedTurns: completions().length,
    ghostEvents: ghosts().length,
    afterReload,
    automatic,
  };
  assert.equal(evidence.streamedAnswers, before ? 4 : 7);
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error(error);
  await context?.pages()[0]?.screenshot({ path: join(output, "failure.png") });
  throw error;
} finally {
  pendingSummary.resolve();
  await context?.close();
  await app.close();
  const socket = workerLocation(backend).socket;
  if (
    await access(socket).then(
      () => true,
      () => false,
    )
  ) {
    const adapter = createClaudeWorkerAdapter({
      backend,
      config,
      send() {},
      broadcast() {},
    });
    try {
      await adapter.connect();
      // 此 Worker 的配置与 socket 都在独立的测试目录内。
      const pid = adapter.workerPid;
      assert(pid, "已连接隔离 Claude Worker");
      process.kill(pid, "SIGTERM");
      const stopped = AbortSignal.timeout(5000);
      while (
        await access(socket).then(
          () => true,
          () => false,
        )
      )
        await delay(25, undefined, { signal: stopped });
    } finally {
      adapter.close();
    }
  }
  await model.close();
  await rm(root, { recursive: true, force: true });
}
