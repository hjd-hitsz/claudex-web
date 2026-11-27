import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { authenticationFixture } from "../helpers/auth.mjs";

const before = Boolean(process.env.AGY_BEFORE_ROOT);
const project = resolve(process.env.AGY_BEFORE_ROOT || ".");
const moduleFromProject = (path) => import(pathToFileURL(join(project, path)));
const { createWebApplication } = await moduleFromProject(
  "server/src/application.mjs",
);
const { createAuthentication } = await moduleFromProject("server/src/auth.mjs");
const { createBackendConfiguration } = await moduleFromProject(
  "server/src/backends/configuration.mjs",
);
const { connectIpc, workerLocation } = await moduleFromProject(
  "server/src/backends/agy/worker-ipc.mjs",
);
const { readConfig } = await moduleFromProject("server/src/config.mjs");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const realAgy =
  process.env.AGY_EXECUTABLE ||
  execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
const root = await mkdtemp(join(tmpdir(), "claudex-compact-"));
const output = resolve(
  process.env.AGY_COMPACTION_OUTPUT || ".cache/agy-compact",
  before ? "before" : "after",
);
const cwd = join(root, "workspace");
const home = join(root, "home");
const bin = join(root, "bin");
const profile = join(home, ".gemini", "antigravity-cli");
await Promise.all(
  [cwd, bin, profile, output].map((path) => mkdir(path, { recursive: true })),
);
await writeFile(
  join(profile, "settings.json"),
  JSON.stringify({
    modelProvider: "gemini",
    auth: { type: "gemini-api-key" },
  }),
);
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
await writeFile(
  join(bin, "agy"),
  `#!/bin/sh\nexec ${quote(realAgy)} "$@" --disable-telemetry\n`,
  { mode: 0o700 },
);
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
Object.assign(process.env, {
  HOME: home,
  XDG_RUNTIME_DIR: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  PATH: bin + ":" + process.env.PATH,
  GEMINI_API_KEY: "isolated-agy-compaction",
});
delete process.env.DBUS_SESSION_BUS_ADDRESS;
const first = "隔离工作区的第一轮问题";
const original = "第一轮原始答复，用于回读历史。";
const manualSummary = "孤立的手动整理摘要";
const autoSummary = "孤立的自动整理摘要";
const followup = "请继续讨论检查点中的任务";
const heavy = "记录本轮高占用量";
const automaticFollowup = "请在自动整理后继续核对";
const failedRetry = "整理失败后继续核对";
const noUsage = "记录缺少用量的回复";
const noUsageAnswer = "隔离端点未提供本轮用量。";
const responses = [];
const requests = [];
const events = [];
const tokenEvidence = [];
const historyEvidence = [];
let summaries = 0;
let trySummaryTool = false;
let triedSummaryTool = false;
const firstSummary = Promise.withResolvers();
const model = createServer(async (req, res) => {
  if (req.method === "GET")
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end('{"models":[]}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const {
    contents = [],
    systemInstruction,
    tools,
  } = JSON.parse(Buffer.concat(chunks));
  const text = JSON.stringify(contents.at(-1)?.parts);
  const manual =
    text.includes("Create a continuation checkpoint from these records.") ||
    (before && text.includes("/compact"));
  const summary = manual || text.includes("resume work efficiently");
  const title = JSON.stringify(systemInstruction).includes(
    "conversation title generator",
  );
  requests.push({
    url: new URL(req.url, "http://localhost").pathname,
    title,
    summary,
    tools,
    contents,
  });
  if (summary && !title && summaries++ === 0) await firstSummary.promise;
  const afterAutomatic =
    text.includes("<CONTEXT_SUMMARY>") && text.includes(automaticFollowup);
  const answer = title
    ? "上下文整理验收"
    : summary
      ? manual
        ? summaries > 2
          ? "模拟摘要格式错误"
          : before
            ? manualSummary
            : JSON.stringify({ summary: manualSummary })
        : autoSummary
      : text.includes(noUsage)
        ? noUsageAnswer
        : text.includes(failedRetry)
          ? "原会话仍可继续。"
          : afterAutomatic
            ? "已在自动检查点后继续。"
            : text.includes(first)
              ? original
              : text.includes(followup)
                ? "已在手动检查点后继续。"
                : text.includes(heavy)
                  ? "已记录高占用量。"
                  : "已在自动检查点后继续。";
  const used =
    !summary && !afterAutomatic && text.includes(heavy) ? 400000 : 700;
  const manualContinuation = !afterAutomatic && text.includes(followup);
  const cachedContentTokenCount = summary ? 21 : manualContinuation ? 27 : 19;
  const candidatesTokenCount = summary ? 8 : manualContinuation ? 10 : 9;
  const usageMetadata = text.includes(noUsage)
    ? undefined
    : {
        promptTokenCount: used,
        cachedContentTokenCount,
        candidatesTokenCount,
        thoughtsTokenCount: 13 - candidatesTokenCount,
        totalTokenCount: used + 13,
      };
  const body = JSON.stringify({
    candidates: [
      {
        content: {
          role: "model",
          parts:
            trySummaryTool && manual && !title && !triedSummaryTool
              ? [
                  {
                    functionCall: {
                      name: "manage_task",
                      args: { Action: "list" },
                    },
                  },
                ]
              : [{ text: answer }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata,
  });
  if (trySummaryTool && manual && !title) triedSummaryTool = true;
  responses.push({ summary, title, used, usageMetadata });
  if (req.url.includes("streamGenerateContent"))
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end("data: " + body + "\n\n");
  else res.writeHead(200, { "content-type": "application/json" }).end(body);
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
process.env.GOOGLE_GEMINI_BASE_URL = "http://127.0.0.1:" + model.address().port;
const config = {
  ...readConfig({
    ...process.env,
    CLAUDEX_WEB_CONFIG_DIR: root,
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    DEFAULT_CWD: cwd,
    HOST: "127.0.0.1",
    PORT: "0",
  }),
  ...(before && { staticDir: join(output, "dist") }),
};
const settings = createBackendConfiguration(config);
for (const id of ["codex", "claude", "agy"])
  await settings.save({
    id,
    type: id,
    enabled: id === "agy",
    ...(id === "agy" && { proxy: { mode: "off" } }),
  });
const auth = await authenticationFixture(root);
const app = createWebApplication({
  config,
  tls: auth.tls,
  authentication: await createAuthentication(config),
  version: { version: "4.2.3", displayVersion: "4.2.3" },
});
const state = async () =>
  Object.values(
    JSON.parse(
      await readFile(join(root, "backends", "agy", "state.json"), "utf8"),
    ).sessions,
  )[0];
let context;
try {
  await app.start();
  const url = "https://127.0.0.1:" + app.server.address().port;
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
  const page = await context.newPage();
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const packet = JSON.parse(payload);
      if (
        [
          "lan/compaction",
          "thread/tokenUsage/updated",
          "turn/completed",
        ].includes(packet.method)
      )
        events.push(packet);
    }),
  );
  const screenshot = (name) =>
    page.screenshot({ path: join(output, name + ".png") });
  page.setDefaultTimeout(12000);
  await page.goto(url);
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  const box = page.getByRole("textbox", { name: "消息", exact: true });
  const send = async (text) => {
    await box.fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
  };
  const compact = async () => {
    await page.getByRole("button", { name: "对话操作" }).click();
    await page.getByRole("button", { name: "整理上下文", exact: true }).click();
  };
  const contextInfo = page.locator(".context-info");
  const usageButton = page.getByRole("button", { name: "查看 Token 用量明细" });
  const usageDetails = page.getByRole("region", { name: "Token 用量明细" });
  const latestUsage = () =>
    events.findLast(({ method }) => method === "thread/tokenUsage/updated")
      .params.tokenUsage;
  const usageRows = () =>
    usageDetails
      .locator("dl > div")
      .evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.map((node) => [
            node.querySelector("dt").textContent,
            Number(node.querySelector("dd").textContent.replaceAll(",", "")),
          ]),
        ),
      );
  const expectRows = (round) => {
    const labels = {
      inputTokens: "输入",
      cachedInputTokens: "缓存输入",
      outputTokens: "输出",
      reasoningOutputTokens: "推理输出",
      totalTokens: "本轮总量",
    };
    return {
      ...Object.fromEntries(
        Object.entries(round).map(([key, value]) => [labels[key], value]),
      ),
      模型窗口上限: 1048576,
    };
  };
  async function inspectUsage(label, expected, selectPrevious = false) {
    await usageButton.click();
    if (selectPrevious)
      await usageDetails
        .getByRole("combobox")
        .selectOption({ label: "上一轮" });
    const rows = await usageRows();
    const usage = selectPrevious
      ? (await state()).turns.at(-2).tokenUsage
      : latestUsage();
    assert.deepEqual(usage.round, expected);
    assert.deepEqual(rows, expectRows(expected));
    if (Object.keys(expected).length === 0)
      await usageDetails.getByText("本轮明细未上报").waitFor();
    tokenEvidence.push({ label, usage, rows });
    await screenshot("tokens-" + label);
    await page.keyboard.press("Escape");
    await usageDetails.waitFor({ state: "hidden" });
    assert(
      await usageButton.evaluate((node) => node === document.activeElement),
    );
  }
  async function inspectHistory(label, takeScreenshots = false) {
    const turns = (await state()).turns.toReversed();
    const [current, ...historical] = turns.filter((turn) => turn.tokenUsage);
    assert(current && historical.length >= 2);
    await usageButton.click();
    const select = usageDetails.getByRole("combobox", { name: "选择用量轮次" });
    const options = select.locator("option");
    await options
      .filter({ hasText: /^上一轮$/ })
      .waitFor({ state: "attached" });
    const available = await options.evaluateAll((nodes) =>
      nodes.map(({ value, textContent, title }) => ({
        value,
        label: textContent,
        title,
      })),
    );
    assert.deepEqual(
      available.map(({ value }) => value),
      ["", ...historical.map(({ id }) => id)],
    );
    assert.deepEqual(
      available.map(({ label }) => label),
      [
        "本轮",
        "上一轮",
        ...historical.slice(1).map((_, index) => `更早 · ${index + 2} 轮前`),
      ],
    );
    const timestamps = await page.evaluate(
      (times) => times.map((time) => new Date(time * 1000).toLocaleString()),
      historical.map(({ startedAt }) => startedAt),
    );
    assert.deepEqual(
      available.slice(1).map(({ title }) => title),
      timestamps,
    );
    const displayed = [];
    for (const [index, turn] of [
      current,
      ...historical.slice(0, 2),
    ].entries()) {
      await select.selectOption({ index });
      const rows = await usageRows();
      assert.deepEqual(rows, expectRows(turn.tokenUsage.round));
      assert.equal(
        (await select.getAttribute("title")) ?? "",
        available[index].title,
      );
      const entry = { ...available[index], rows };
      if (takeScreenshots) {
        assert.equal(turn.status, "completed");
        entry.geometry = await select.evaluate((element) => {
          // Measure the native control with only the selected option to include
          // the space Chromium reserves for the arrow and padding.
          const probe = element.cloneNode(false);
          probe.append(element.selectedOptions[0].cloneNode(true));
          Object.assign(probe.style, {
            position: "fixed",
            visibility: "hidden",
            width: "max-content",
            maxWidth: "none",
          });
          element.after(probe);
          const requiredWidth = probe.getBoundingClientRect().width;
          probe.remove();
          const panel = element.closest(".agy-context-details");
          return {
            viewport: innerWidth,
            dpr: devicePixelRatio,
            availableWidth: element.getBoundingClientRect().width,
            requiredWidth,
            panelOverflow: panel.scrollWidth - panel.clientWidth,
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
        const {
          viewport,
          dpr,
          availableWidth,
          requiredWidth,
          panelOverflow,
          pageOverflow,
        } = entry.geometry;
        assert.equal(viewport, 195);
        assert.equal(dpr, 2);
        assert(availableWidth >= requiredWidth, JSON.stringify(entry));
        assert(panelOverflow <= 0 && pageOverflow <= 0, JSON.stringify(entry));
        await screenshot(`tokens-history-${label}-${index}`);
      }
      displayed.push(entry);
    }
    if (takeScreenshots)
      assert.deepEqual(
        displayed.map(({ rows }) => rows["本轮总量"]),
        [1426, 400013, 713],
      );
    historyEvidence.push({ label, options: available, displayed });
    await page.keyboard.press("Escape");
    await usageDetails.waitFor({ state: "hidden" });
  }
  async function tokenLayout() {
    const browserSettings = await context.newPage();
    await browserSettings.goto("chrome://settings/appearance");
    const zoom = browserSettings.locator("#zoomLevel");
    const checks = [];
    try {
      for (const width of [1400, 390]) {
        await page.setViewportSize({ width, height: 920 });
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme });
          for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
            await zoom.selectOption(String(scale));
            await page.waitForFunction(
              (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
              scale,
            );
            await usageButton.click();
            const geometry = await usageDetails.evaluate((element) => {
              const { left, right, top, bottom } =
                element.getBoundingClientRect();
              return {
                left,
                right,
                top,
                bottom,
                dpr: devicePixelRatio,
                viewport: innerWidth,
                height: innerHeight,
                horizontalOverflow: element.scrollWidth - element.clientWidth,
              };
            });
            assert(Math.abs(geometry.viewport - width / scale) <= 1);
            assert(
              geometry.left >= 0 && geometry.right <= geometry.viewport + 1,
            );
            assert(geometry.top >= 0 && geometry.bottom <= geometry.height + 1);
            assert(geometry.horizontalOverflow <= 1);
            checks.push({ width, colorScheme, scale, ...geometry });
            if (scale === 1 || (width === 390 && scale === 2))
              await screenshot(`tokens-${width}-${colorScheme}-${scale * 100}`);
            await page.keyboard.press("Escape");
            await usageDetails.waitFor({ state: "hidden" });
          }
        }
      }
    } finally {
      await zoom.selectOption("1");
      await browserSettings.close();
      await page.setViewportSize({ width: 1400, height: 920 });
      await page.emulateMedia({ colorScheme: "light" });
      await writeFile(
        join(output, "token-layout.json"),
        JSON.stringify(checks, null, 2),
      );
    }
  }
  const normalUsage = {
    inputTokens: 681,
    cachedInputTokens: 19,
    outputTokens: 13,
    reasoningOutputTokens: 4,
    totalTokens: 713,
  };
  const summaryUsage = {
    inputTokens: 679,
    cachedInputTokens: 21,
    outputTokens: 13,
    reasoningOutputTokens: 5,
    totalTokens: 713,
  };
  await send(first);
  await page.getByText(original, { exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".context-info")?.textContent.includes("713"),
  );
  await screenshot("before-compact");
  if (!before) await inspectUsage("first", normalUsage);
  const initial = await state();
  await compact();
  await page.locator(".compaction-status.running").waitFor();
  await screenshot("manual-running");
  if (!before) {
    const browserSettings = await context.newPage();
    await browserSettings.goto("chrome://settings/appearance");
    const zoom = browserSettings.locator("#zoomLevel");
    const checks = [];
    for (const width of [1400, 390]) {
      await page.setViewportSize({ width, height: 920 });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.waitForFunction(
            (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
            scale,
          );
          const geometry = await page
            .locator(".compaction-status.running")
            .evaluate((element) => ({
              viewport: innerWidth,
              scroll: document.documentElement.scrollWidth,
              left: element.getBoundingClientRect().left,
              right: element.getBoundingClientRect().right,
            }));
          assert(
            Math.abs(geometry.viewport - width / scale) <= 1,
            JSON.stringify(geometry),
          );
          assert(
            geometry.scroll <= geometry.viewport + 1 &&
              geometry.left >= 0 &&
              geometry.right <= geometry.viewport + 1,
          );
          checks.push({ width, colorScheme, scale, ...geometry });
        }
        await zoom.selectOption("1");
        if (width === 390)
          await screenshot("manual-running-mobile-" + colorScheme);
      }
    }
    await browserSettings.close();
    const sidebar = page.getByRole("button", { name: "显示侧栏", exact: true });
    if (await sidebar.isVisible()) {
      await sidebar.click();
      await screenshot("manual-running-mobile-sidebar");
      await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
      await page.waitForFunction(
        () =>
          !document
            .querySelector("#project-sidebar")
            .contains(document.activeElement),
      );
    }
    await writeFile(
      join(output, "layout.json"),
      JSON.stringify(checks, null, 2),
    );
    await page.setViewportSize({ width: 1400, height: 920 });
    await page.emulateMedia({ colorScheme: "light" });
  }
  firstSummary.resolve();
  const terminal = page.locator(
    ".compaction-status." + (before ? "unconfirmed" : "completed"),
  );
  await terminal.waitFor();
  await screenshot("manual-result");
  if (!before) {
    const summaryRequest = requests.find(
      ({ summary, title }) => summary && !title,
    );
    assert.match(
      JSON.stringify(summaryRequest.contents),
      /<USER_REQUEST>\\nCreate a continuation checkpoint from these records/,
    );
    assert(!JSON.stringify(summaryRequest.contents).includes("/plan "));
    assert.match(await contextInfo.innerText(), /整理后用量/);
    assert.match(await contextInfo.getAttribute("title"), /1,048,576/);
    await inspectUsage("manual-summary", summaryUsage);
  }
  assert.equal(
    await page.getByText(manualSummary, { exact: true }).count(),
    before ? 1 : 0,
  );
  if (!before) {
    await page.reload();
    await page.getByText(original, { exact: true }).waitFor();
    await page.getByText("整理后用量将在下一轮更新", { exact: true }).waitFor();
    await inspectUsage("manual-summary-reloaded", summaryUsage);
  }
  await send(followup);
  await page.getByText("已在手动检查点后继续。", { exact: true }).waitFor();
  await page.getByText(original, { exact: true }).waitFor();
  const afterManual = await state();
  assert.equal(afterManual.id, initial.id);
  assert.equal(afterManual.nativeId === initial.nativeId, before);
  const request = (marker) =>
    requests.findLast(
      ({ title, summary, contents }) =>
        !title && !summary && JSON.stringify(contents.at(-1)).includes(marker),
    );
  const followupContents = JSON.stringify(request(followup).contents);
  assert(followupContents.includes(manualSummary));
  assert.equal(followupContents.includes(original), before);
  await screenshot("manual-continued");
  if (!before) {
    await page.getByText(/713 tokens/).waitFor();
    await inspectUsage("after-manual", {
      inputTokens: 673,
      cachedInputTokens: 27,
      outputTokens: 13,
      reasoningOutputTokens: 3,
      totalTokens: 713,
    });
    await inspectUsage("previous-round", summaryUsage, true);
    await send(heavy);
    await page.getByText("已记录高占用量。", { exact: true }).waitFor();
    await page.getByText(/400,013 tokens/).waitFor();
    await send(automaticFollowup);
    await page.getByText("已在自动检查点后继续。", { exact: true }).waitFor();
    await page.getByText("已自动整理上下文", { exact: true }).waitFor();
    assert.match(await contextInfo.innerText(), /713 tokens/);
    const automaticUsage = Object.fromEntries(
      Object.keys(normalUsage).map((key) => [
        key,
        normalUsage[key] + summaryUsage[key],
      ]),
    );
    await inspectUsage("automatic", automaticUsage);
    await inspectHistory("live");
    await tokenLayout();
    const autoContents = JSON.stringify(request(automaticFollowup).contents);
    assert(autoContents.includes(autoSummary));
    assert(!autoContents.includes(original));
    await screenshot("automatic-result");
    await page.reload();
    await page.getByText("已在自动检查点后继续。", { exact: true }).waitFor();
    await page.getByText(original, { exact: true }).waitFor();
    await usageButton.waitFor();
    await inspectUsage("automatic-reloaded", automaticUsage);
    await inspectHistory("reloaded");
    const historySettings = await context.newPage();
    await historySettings.goto("chrome://settings/appearance");
    const zoom = historySettings.locator("#zoomLevel");
    await page.setViewportSize({ width: 390, height: 920 });
    await page.emulateMedia({ colorScheme: "dark" });
    await zoom.selectOption("2");
    await page.waitForFunction(() => Math.abs(devicePixelRatio - 2) < 0.02);
    await page.waitForFunction(
      () =>
        document.querySelector("#project-sidebar").getBoundingClientRect()
          .right <= 1,
    );
    await inspectHistory("mobile-200", true);
    await zoom.selectOption("1");
    await historySettings.close();
    await page.setViewportSize({ width: 1400, height: 920 });
    await page.emulateMedia({ colorScheme: "light" });
    assert.equal((await state()).nativeId, afterManual.nativeId);
    assert.equal(afterManual.previousNativeId, initial.nativeId);
    const database = new DatabaseSync(
      join(profile, "conversations", afterManual.nativeId + ".db"),
      { readOnly: true },
    );
    try {
      const rows = database
        .prepare(
          "SELECT idx FROM steps WHERE step_type = 23 AND status = 3 ORDER BY idx",
        )
        .all();
      assert.equal(rows.length, 1);
    } finally {
      database.close();
    }
    const old = new DatabaseSync(
      join(profile, "conversations", initial.nativeId + ".db"),
      { readOnly: true },
    );
    try {
      assert(
        old
          .prepare(
            "SELECT 1 FROM steps WHERE instr(step_payload, CAST(? AS BLOB)) > 0",
          )
          .get(original),
      );
    } finally {
      old.close();
    }
    assert.equal(
      requests.filter(({ summary, title }) => summary && !title).length,
      2,
    );
    await compact();
    await page.locator(".compaction-status.failed").waitFor();
    assert.equal((await state()).nativeId, afterManual.nativeId);
    await screenshot("manual-failed");
    await inspectUsage("manual-failed", summaryUsage);
    await send(failedRetry);
    await page.getByText("原会话仍可继续。", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "停止任务", exact: true })
      .waitFor({ state: "hidden" });
    trySummaryTool = true;
    await compact();
    await page.locator(".compaction-status.failed").waitFor();
    assert(triedSummaryTool);
    assert(
      requests.some(({ contents }) =>
        JSON.stringify(contents).includes("tool call denied by pre-tool hook"),
      ),
    );
    assert.equal((await state()).nativeId, afterManual.nativeId);
    await screenshot("manual-tool-denied");
    await send(noUsage);
    await page.getByText(noUsageAnswer, { exact: true }).waitFor();
    await page.getByText("查看本轮 Token 用量", { exact: true }).waitFor();
    await inspectUsage("no-usage", {});
    await page.reload();
    await page.getByText(noUsageAnswer, { exact: true }).waitFor();
    await inspectUsage("no-usage-reloaded", {});
    let legacySnapshots = 0;
    await page.routeWebSocket(
      (url) => url.hostname === "127.0.0.1",
      (route) => {
        const upstream = route.connectToServer();
        upstream.onMessage((message) => {
          const packet = JSON.parse(message);
          const snapshot = packet.result?.thread?.tokenUsage;
          if (snapshot?.turnId) {
            delete snapshot.turnId;
            legacySnapshots++;
            route.send(JSON.stringify(packet));
          } else route.send(message);
        });
      },
    );
    await page.reload();
    await page.getByText(noUsageAnswer, { exact: true }).waitFor();
    await inspectHistory("legacy-snapshot");
    assert(legacySnapshots > 0, "刷新须读取到缺少 turnId 的快照");
  }
  console.log(
    JSON.stringify({
      before,
      realCli: execFileSync(realAgy, ["--version"], {
        encoding: "utf8",
      }).trim(),
      originalReadable: true,
      sameThread: true,
      sameNativeSession: before,
      followupUsesSummary: !before,
      summaryToolDenied: triedSummaryTool,
      compactionStatuses: events
        .filter(({ method }) => method === "lan/compaction")
        .map(({ params }) => params.compaction.status),
      output,
    }),
  );
} finally {
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(
      {
        events,
        requests,
        responses,
        tokenEvidence,
        historyEvidence,
        session: await state().catch(() => null),
      },
      null,
      2,
    ),
  );
  firstSummary.resolve();
  await context?.close();
  const worker = await connectIpc(
    workerLocation(join(root, "backends", "agy")).socket,
  ).catch(() => null);
  if (worker) {
    await worker.call("shutdown").catch(() => {});
    worker.close();
  }
  await app.close();
  model.close();
  await rm(root, { recursive: true, force: true });
}
