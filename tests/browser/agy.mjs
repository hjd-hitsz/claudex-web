import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import {
  openSettingsPage,
  settingsBackend,
  switchComposerBackend,
} from "../helpers/settings-navigation.mjs";

function fixture() {
  const cwd = "/demo/report";
  const thread = {
    id: "backend:agy:secretary",
    backendId: "agy",
    name: "技术报告",
    cwd,
    model:
      sessionStorage.getItem("fixture-thread-model") || "gemini-4-hydrogen",
    status: { type: "idle" },
    createdAt: 10,
    updatedAt: 12,
  };
  const task = {
    id: "delegate-1",
    type: "subAgentActivity",
    kind: "interacted",
    agentThreadId: "backend:agy:delegation%2Fdemo",
    agentPath: "Codex",
    agentStatus: "completed",
    prompt: "核对报告所需的技术依据",
    model: "gpt-fixture",
    delegation: {
      taskId: "demo",
      target: "codex",
      status: "completed",
      executorThreadId: "native-demo",
      result: {
        answer: "已核对技术证据，供秘书写入文档。",
        artifacts: [{ path: "report.md", kind: { type: "add" } }],
      },
    },
  };
  const turn = {
    id: "turn-1",
    status: "completed",
    startedAt: 10,
    completedAt: 12,
    items: [
      {
        id: "user",
        type: "userMessage",
        content: [{ type: "text", text: "请核对技术证据并写成报告。" }],
      },
      task,
      {
        id: "answer",
        type: "agentMessage",
        text: "证据已核对，报告已写入工作区。",
        phase: "final_answer",
      },
    ],
  };
  const native = {
    ...thread,
    id: task.agentThreadId,
    model: "gpt-fixture",
    name: "委派执行",
  };
  const nativeTurn = {
    ...turn,
    id: "native-turn",
    items: [
      {
        id: "native-input",
        type: "userMessage",
        authorLabel: "Antigravity",
        content: [{ type: "text", text: "核对两个文件，并汇报证据。" }],
      },
      {
        id: "native-command",
        type: "commandExecution",
        command: "nl -ba report.md",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "1 核对清单",
      },
      {
        id: "native-reply",
        type: "agentMessage",
        phase: "final_answer",
        text: "Codex 核对了原生文件内容。",
      },
    ],
  };
  const delegates = {
    codex: {
      enabled: true,
      model: "gpt-fixture",
      effort: "high",
      providerId: "",
    },
    claude: { enabled: true, model: "sonnet", effort: "", providerId: "" },
  };
  const backends = [
    { id: "codex", name: "Codex" },
    { id: "claude", name: "Claude Code" },
    {
      id: "agy",
      name: "Antigravity",
      delegates: JSON.parse(sessionStorage.agyDelegates || "null") || delegates,
      hiddenModels: JSON.parse(sessionStorage.agyHiddenModels || "[]"),
    },
  ].map((backend) => ({
    type: backend.id,
    enabled: true,
    ready: true,
    installation: { installed: true, currentVersion: "1.5.17" },
    capabilities: {
      fork: true,
      compact: true,
      subagents: true,
      ...(backend.id === "agy" && { delegation: true }),
    },
    ...backend,
  }));
  const restoreDraft = sessionStorage.getItem("verify-model-refresh") !== null;
  if (!restoreDraft) {
    localStorage.setItem("cx-current", thread.id);
    localStorage.setItem("cx-backend", JSON.stringify("agy"));
  }
  window.fixtureRequests = [];
  window.holdAgyCatalogue = restoreDraft;
  const heldCatalogues = [];
  window.releaseAgyCatalogue = () => {
    window.holdAgyCatalogue = false;
    heldCatalogues.splice(0).forEach((reply) => reply());
  };
  const defaultRole = "你是用户的秘书。\n\n委派技术工作并核对结果。\n";
  const permission = {
    id: "agy-permission-demo",
    method: "lan/agy/permission",
    params: {
      threadId: thread.id,
      executorName: "Claude Code",
      reason: "需要在报告目录写入技术验证产物。",
      scope: { path: "checks.txt" },
      options: [{ optionId: "allow", name: "允许一次", kind: "allow_once" }],
    },
  };
  const model = (id, displayName) => ({
    id,
    model: id,
    displayName,
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  });
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      window.showFixturePermission = () => this.emit(permission);
      window.publishAgyCatalogue = () =>
        this.emit({
          method: "lan/agy/models",
          params: {
            model: "gemini-4-hydrogen",
            effort: "high",
            models: [
              ...this.reply("model/list", { backendId: "agy" }).data,
              model("gemini-added", "Gemini Added"),
            ],
          },
        });
      setTimeout(() => {
        this.onopen?.({});
        this.emit({
          method: "lan/state",
          params: {
            ready: true,
            bridgeReady: true,
            defaultBackendId: "agy",
            defaultCwd: cwd,
            activeTurns: {},
            questions: [],
            compactions: {},
            backends,
            projectModels: true,
          },
        });
      }, 0);
    }
    emit(packet) {
      this.onmessage?.({ data: JSON.stringify(packet) });
    }
    send(message) {
      const { id, method, params = {} } = JSON.parse(message);
      window.fixtureRequests.push({ method, params });
      if (
        method === "lan/backends/agy/role/read" &&
        !sessionStorage.roleReadFailed
      ) {
        sessionStorage.roleReadFailed = "yes";
        queueMicrotask(() =>
          this.emit({
            id,
            error: { code: -32000, message: "角色设定读取失败" },
          }),
        );
        return;
      }
      if (
        method === "lan/backends/agy/role/save" &&
        !sessionStorage.roleSaveFailed
      ) {
        sessionStorage.roleSaveFailed = "yes";
        queueMicrotask(() =>
          this.emit({
            id,
            error: { code: -32000, message: "角色设定保存失败，请重试" },
          }),
        );
        return;
      }
      if (method === "lan/agy/respond") {
        queueMicrotask(() => {
          if (
            window.fixtureRequests.filter((r) => r.method === method).length ===
            1
          ) {
            this.emit({
              id,
              error: { code: -32000, message: "确认提交暂时失败" },
            });
            return;
          }
          this.emit({ id, result: {} });
          this.emit({
            method: "serverRequest/resolved",
            params: { requestId: permission.id },
          });
        });
        return;
      }
      const result = this.reply(method, params);
      if (
        method === "model/list" &&
        params.backendId === "agy" &&
        window.holdAgyCatalogue
      ) {
        heldCatalogues.push(() => this.emit({ id, result }));
        return;
      }
      if (id !== undefined) queueMicrotask(() => this.emit({ id, result }));
    }
    reply(method, p) {
      if (p.threadId === native.id) {
        if (method === "thread/read") return { thread: native };
        if (method === "thread/turns/list")
          return { data: [nativeTurn], nextCursor: null };
        if (method === "thread/items/list")
          return {
            data: nativeTurn.items.map((item) => ({
              item,
              turnId: nativeTurn.id,
            })),
            nextCursor: null,
          };
      }
      if (method === "thread/list")
        return { data: p.archived ? [] : [thread], nextCursor: null };
      if (method === "thread/read" || method === "thread/resume")
        return {
          thread,
          model: thread.model,
          cwd,
          collaborationMode: { mode: "default" },
        };
      if (method === "thread/turns/list")
        return { data: [turn], nextCursor: null };
      if (method === "thread/fork")
        return { thread: { ...thread, id: "backend:agy:branch", name: "" } };
      if (method === "thread/items/list")
        return {
          data: turn.items
            .toReversed()
            .map((item) => ({ item, turnId: turn.id })),
          nextCursor: null,
        };
      if (method === "lan/backends/list" || method === "lan/backends/versions")
        return { backends };
      if (method === "lan/backends/agy/role/save") {
        if (p.content === defaultRole) delete sessionStorage.agyRole;
        else sessionStorage.agyRole = p.content;
      }
      if (method.startsWith("lan/backends/agy/role/"))
        return {
          content: sessionStorage.agyRole ?? defaultRole,
          defaultContent: defaultRole,
          customized: "agyRole" in sessionStorage,
        };
      if (method === "lan/backends/save") {
        const backend = backends.find(({ id }) => id === p.id);
        Object.assign(backend, p);
        if (p.delegates)
          sessionStorage.agyDelegates = JSON.stringify(p.delegates);
        if (p.hiddenModels)
          sessionStorage.agyHiddenModels = JSON.stringify(p.hiddenModels);
        return { backends };
      }
      if (method === "lan/providers/list") return { providers: [] };
      if (method === "model/list")
        return {
          data:
            p.backendId === "codex"
              ? [
                  model("gpt-fixture", "GPT fixture"),
                  model("gpt-second", "GPT second"),
                ]
              : p.backendId === "claude"
                ? [model("sonnet", "Sonnet"), model("opus", "Opus")]
                : [
                    model("gemini-4-hydrogen", "Gemini 4 Hydrogen"),
                    model("gemini-3.8-flash", "Gemini 3.8 Flash"),
                    model("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"),
                    model(
                      "claude-opus-4-6-thinking",
                      "Claude Opus 4.6 (Thinking)",
                    ),
                    model("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
                  ],
        };
      if (method === "account/read")
        return { account: { type: "agy", usageSupported: true } };
      if (method === "account/rateLimits/read")
        return {
          rateLimits: {
            limitId: "agy",
            windows: [
              {
                label: "Gemini 5 小时额度",
                shortLabel: "5h",
                usedPercent: 22,
                windowDurationMins: 300,
              },
              {
                label: "Gemini 周额度",
                shortLabel: "周",
                usedPercent: 36,
                windowDurationMins: 10080,
              },
              {
                label: "第三方模型 5 小时额度",
                usedPercent: 27,
                windowDurationMins: 300,
              },
              {
                label: "第三方模型周额度",
                usedPercent: 41,
                windowDurationMins: 10080,
              },
            ],
          },
        };
      if (method === "skills/list") return { data: [] };
      if (method === "config/read") return { config: { model: thread.model } };
      if (
        method === "lan/projectModels/read" ||
        method === "lan/projectModels/set"
      ) {
        const key = "fixture-project-models-" + p.backendId;
        const projects = JSON.parse(sessionStorage.getItem(key) || "{}");
        if (method.endsWith("/set")) {
          projects[p.cwd] = { model: p.model, effort: p.effort };
          sessionStorage.setItem(key, JSON.stringify(projects));
        }
        return { projects };
      }
      if (method === "lan/projectless/read") return { directories: [] };
      if (method === "turn/start")
        return { turn: { id: "submitted", status: "inProgress", items: [] } };
      return {};
    }
    close() {
      this.readyState = 3;
    }
  }
  window.WebSocket = Socket;
}

const build = process.env.BROWSER_BUILD_DIR
  ? pathToFileURL(process.env.BROWSER_BUILD_DIR.replace(/\/$/, "") + "/")
  : new URL("../../client/dist/", import.meta.url);
const output = process.env.AGY_BROWSER_OUTPUT_DIR
  ? pathToFileURL(process.env.AGY_BROWSER_OUTPUT_DIR.replace(/\/$/, "") + "/")
  : new URL("../../.cache/agy-browser/", import.meta.url);
await mkdir(output, { recursive: true });
const listener = createServer(async (req, res) => {
  if (serveDemoSession(req, res)) return;
  try {
    const path = new URL(req.url, "http://fixture").pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    let bytes = await readFile(new URL(file, build));
    if (path === "/")
      bytes = bytes
        .toString()
        .replace("<head>", `<head><script>(${fixture.toString()})();</script>`);
    res
      .writeHead(200, {
        "content-type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
            ".svg": "image/svg+xml",
          }[extname(file)] || "text/html",
      })
      .end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-agy-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1440, height: 980 },
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const page = await context.newPage();
page.setDefaultTimeout(9000);
page.on("console", (message) => {
  if (message.type() === "error") console.error("browser", message.text());
});
const errors = [];
async function openBackendSettings(name) {
  const sidebar = page.getByRole("button", { name: "显示侧栏", exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole("button", { name: "账户与设置" }).click();
  await openSettingsPage(page, "后端");
  await settingsBackend(page, name).click();
}
const agy = page.locator('.backend-card[data-backend="agy"]');
const modelSelect = page.getByRole("combobox", { name: "模型", exact: true });
const roleSection = page.getByRole("region", {
  name: "默认提示词",
  exact: true,
});
const roleEditor = roleSection.getByRole("textbox", { name: "默认提示词正文" });
const saveRole = roleSection.getByRole("button", { name: "保存默认提示词" });
try {
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  const delegate = page.getByRole("button", { name: /^本轮委派：/ });
  await delegate.waitFor();
  assert.equal(await delegate.count(), 1);
  assert.equal(await delegate.getAttribute("aria-label"), "本轮委派：Codex");
  const agyIcon = page.locator(".topbar .backend-badge[data-backend=agy] img");
  const avatar = page
    .getByRole("button", { name: "账户与设置" })
    .locator("img");
  await agyIcon.waitFor();
  assert(
    await page.locator(".topbar").evaluate((header) => {
      const backend = header.querySelector(".backend-switcher");
      const folder = header.querySelector(".project-switcher");
      return (
        backend.getBoundingClientRect().right <=
          folder.getBoundingClientRect().left &&
        getComputedStyle(backend).borderInlineStartWidth === "0px"
      );
    }),
  );
  assert.equal(
    await agyIcon.getAttribute("src"),
    await avatar.getAttribute("src"),
  );
  await delegate.click();
  assert.equal(
    await delegate.getAttribute("aria-label"),
    "本轮委派：Claude Code",
  );
  await page.screenshot({
    path: new URL("switch-claude.png", output).pathname,
  });
  await delegate.press("Enter");
  assert.equal(await delegate.getAttribute("aria-label"), "本轮委派：Codex");
  assert.equal(
    await page.getByRole("button", { name: "计划模式", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "展开额度详情" }).click();
  await page.getByText("第三方模型周额度").waitFor();
  await page.screenshot({ path: new URL("quota.png", output).pathname });
  await page.getByRole("button", { name: "收起额度详情" }).click();
  const detailButton = page.getByRole("button", {
    name: "展开对话详情",
    exact: true,
  });
  if (await detailButton.isVisible()) await detailButton.click();
  await page
    .locator(".context-agent-list")
    .getByRole("button", { name: /Codex/ })
    .click();
  const execution = page.getByRole("region", { name: "Codex 委派对话" });
  await execution.getByText("Codex 核对了原生文件内容。").waitFor();
  assert.equal(
    await execution.getByRole("button", { name: "查看执行会话" }).count(),
    0,
  );
  assert.equal(
    await execution.getByText("nl -ba report.md", { exact: true }).count(),
    0,
  );
  assert(
    !(await page.evaluate(() =>
      window.fixtureRequests.some(
        ({ method, params }) =>
          method === "thread/goal/get" &&
          params.threadId?.startsWith("backend:agy:"),
      ),
    )),
  );
  await page.screenshot({ path: new URL("delegation.png", output).pathname });
  const process = execution.getByText("工作过程", { exact: true });
  await process.click();
  await execution.getByTitle("nl -ba report.md").click();
  await execution.getByText("1 核对清单", { exact: true }).waitFor();
  await execution.getByText(/退出码 0/).waitFor();
  await page.screenshot({
    path: new URL("delegation-evidence.png", output).pathname,
  });
  await process.click();
  await page.evaluate(() => window.showFixturePermission());
  const allow = page.getByRole("button", { name: "允许一次", exact: true });
  await allow.waitFor();
  await page.getByText("Claude Code · 等待你的确认").waitFor();
  await page.screenshot({ path: new URL("approval.png", output).pathname });
  await allow.click();
  await page.getByText("确认提交暂时失败").waitFor();
  await allow.click();
  await allow.waitFor({ state: "hidden" });
  await openBackendSettings("Antigravity");
  await agy.waitFor();
  assert.equal(
    await agy.getByRole("textbox", { name: "默认提示词正文" }).count(),
    0,
  );
  assert.equal(
    await agy.getByRole("button", { name: /一键安装|更新至|无需更新/ }).count(),
    0,
  );
  const hyd = agy.getByRole("checkbox", {
    name: "Gemini 4 Hydrogen",
    exact: true,
  });
  await hyd.uncheck();
  await hyd.waitFor();
  await openSettingsPage(page, "委派模式");
  await roleSection.getByRole("alert").getByText("角色设定读取失败").waitFor();
  await roleSection.getByRole("button", { name: "重新加载" }).click();
  await roleEditor.waitFor();
  const delegation = page.getByRole("form", { name: "委派模式" });
  const route = delegation.getByRole("checkbox", {
    name: "Claude Code 接收委派",
  });
  await route.uncheck();
  assert.equal(await route.isChecked(), false);
  await route.check();
  await delegation
    .getByLabel("Codex 执行模型")
    .selectOption(JSON.stringify(["", "gpt-second"]));
  await openSettingsPage(page, "后端");
  assert.equal(await delegation.isVisible(), false);
  await openSettingsPage(page, "委派模式");
  assert.equal(
    await delegation.getByLabel("Codex 执行模型").inputValue(),
    JSON.stringify(["", "gpt-second"]),
  );
  await delegation.getByRole("button", { name: "保存委派设置" }).click();
  await delegation.getByText("委派设置已保存").waitFor();
  await page.screenshot({ path: new URL("settings.png", output).pathname });
  const defaultRole = await roleEditor.inputValue();
  assert.match(defaultRole, /用户的秘书/);
  const customRole =
    "你是项目秘书。\n\n- 先确认交付范围。\n- 完成后汇报验证结果。\n";
  await roleEditor.fill(customRole);
  await openSettingsPage(page, "后端");
  assert.equal(await roleEditor.isVisible(), false);
  await openSettingsPage(page, "通用");
  assert.equal(await roleEditor.isVisible(), false);
  await openSettingsPage(page, "委派模式");
  assert.equal(await roleEditor.inputValue(), customRole);
  assert.equal(
    await page.evaluate(
      () =>
        window.fixtureRequests.filter(
          ({ method }) => method === "lan/backends/agy/role/read",
        ).length,
    ),
    2,
  );
  await saveRole.click();
  await roleSection
    .getByRole("alert")
    .getByText("角色设定保存失败，请重试")
    .waitFor();
  assert.equal(await roleEditor.inputValue(), customRole);
  await saveRole.click();
  await roleSection.getByText("默认提示词已保存").waitFor();
  await page.screenshot({ path: new URL("role-saved.png", output).pathname });
  await page.reload();
  await openBackendSettings("Antigravity");
  await openSettingsPage(page, "委派模式");
  await roleEditor.waitFor();
  assert.equal(await roleEditor.inputValue(), customRole);
  await roleSection.getByRole("button", { name: "载入内置模板" }).click();
  assert.equal(await roleEditor.inputValue(), defaultRole);
  assert.equal(await page.evaluate(() => sessionStorage.agyRole), customRole);
  await saveRole.click();
  await roleSection.getByText("已恢复内置提示词").waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.agyRole), undefined);
  await page.screenshot({ path: new URL("role-reset.png", output).pathname });
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  const hiddenModel = "当前模型已隐藏：Antigravity/Gemini 4 Hydrogen";
  const hiddenSelection = page.locator(".model-select-value", {
    hasText: hiddenModel,
  });
  await hiddenSelection.waitFor({ timeout: 3000 });
  await page.screenshot({
    path: new URL("historical-hidden-model.png", output).pathname,
    animations: "disabled",
  });
  assert.equal(
    await modelSelect.locator("option:checked").textContent(),
    hiddenModel,
  );
  assert.equal(await modelSelect.locator("option:checked").isDisabled(), true);
  assert.equal(
    await modelSelect
      .getByRole("option", {
        name: "Antigravity/Gemini 4 Hydrogen",
        exact: true,
      })
      .count(),
    0,
  );
  assert.equal(
    await modelSelect
      .getByRole("option", {
        name: "Antigravity/Gemini 3.8 Flash",
        exact: true,
      })
      .isEnabled(),
    true,
  );
  await page.evaluate(() =>
    sessionStorage.setItem("fixture-thread-model", "gemini-3.8-flash"),
  );
  await page.reload();
  const restoredModel = "Antigravity/Gemini 3.8 Flash";
  await page
    .locator(".model-select-value", { hasText: restoredModel })
    .waitFor();
  assert.equal(
    await modelSelect.locator("option:checked").textContent(),
    restoredModel,
  );
  await page.screenshot({
    path: new URL("historical-flash-model.png", output).pathname,
    animations: "disabled",
  });
  await page.evaluate(() => sessionStorage.removeItem("fixture-thread-model"));
  await page
    .getByRole("button", { name: /^切换后端，当前为 Antigravity$/ })
    .click();
  await page.getByRole("group", { name: "切换后端", exact: true }).waitFor();
  await page.screenshot({
    path: new URL("backend-switcher.png", output).pathname,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await switchComposerBackend(page, "Codex");
  await modelSelect
    .getByRole("option", { name: "ChatGPT/GPT fixture" })
    .waitFor({ state: "attached" });
  await modelSelect.selectOption({ label: "ChatGPT/GPT second" });
  assert(
    !(await modelSelect.locator("option").allTextContents()).some((label) =>
      /Antigravity|Sonnet/.test(label),
    ),
  );
  await switchComposerBackend(page, "Claude Code");
  await modelSelect
    .getByRole("option", { name: "Claude/Sonnet" })
    .waitFor({ state: "attached" });
  await modelSelect.selectOption({ label: "Claude/Opus" });
  assert(
    !(await modelSelect.locator("option").allTextContents()).some((label) =>
      /Antigravity|ChatGPT/.test(label),
    ),
  );
  const countAgyCatalogues = () =>
    page.evaluate(
      () =>
        window.fixtureRequests.filter(
          ({ method, params }) =>
            method === "model/list" && params.backendId === "agy",
        ).length,
    );
  const initialCatalogueReads = await countAgyCatalogues();
  assert.equal(initialCatalogueReads, 1);
  await page.evaluate(() => (window.holdAgyCatalogue = true));
  async function expectSelectedModel(label) {
    await page.waitForFunction(
      (label) =>
        document.querySelector(".model-select-value")?.textContent.trim() ===
        label,
      label,
      { timeout: 3000 },
    );
    assert.equal(
      await modelSelect.locator("option:checked").textContent(),
      label,
    );
  }
  for (const [backend, label, file] of [
    ["Codex", "ChatGPT/GPT second", "model-restore-codex.png"],
    ["Claude Code", "Claude/Opus", "model-restore-claude.png"],
  ]) {
    await switchComposerBackend(page, backend);
    await expectSelectedModel(label);
    await page.screenshot({
      path: new URL(file, output).pathname,
    });
  }
  assert.equal(await countAgyCatalogues(), initialCatalogueReads);
  await page.evaluate(() => sessionStorage.setItem("verify-model-refresh", ""));
  await page.reload();
  await expectSelectedModel("Claude/Opus");
  assert.equal(await countAgyCatalogues(), 1);
  await page.evaluate(() => sessionStorage.removeItem("verify-model-refresh"));
  await page.evaluate(() => window.releaseAgyCatalogue());
  await switchComposerBackend(page, "Antigravity");
  await modelSelect
    .getByRole("option", { name: /Gemini 3.8 Flash/ })
    .waitFor({ state: "attached" });
  assert(
    !(await modelSelect.locator("option").allTextContents()).some((label) =>
      /Gemini 4 Hydrogen|ChatGPT|Claude\/Sonnet/.test(label),
    ),
  );
  assert.equal(
    await page.getByText("证据已核对，报告已写入工作区。").count(),
    0,
  );
  const agyModelLabel = "Antigravity/Claude Opus 4.6 (Thinking)";
  await modelSelect.selectOption({ label: agyModelLabel });
  await switchComposerBackend(page, "Codex");
  await expectSelectedModel("ChatGPT/GPT second");
  await switchComposerBackend(page, "Antigravity");
  await expectSelectedModel(agyModelLabel);
  assert.equal(await countAgyCatalogues(), 1);
  await page.evaluate(() => window.publishAgyCatalogue());
  await modelSelect
    .getByRole("option", { name: "Antigravity/Gemini Added" })
    .waitFor({ state: "attached" });
  await expectSelectedModel(agyModelLabel);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 420, height: 844 });
  await page.screenshot({
    path: new URL("model-restore-agy-mobile.png", output).pathname,
    animations: "disabled",
  });
  const zoomPage = await context.newPage();
  await zoomPage.goto("chrome://settings/appearance");
  const zoom = zoomPage.locator("#zoomLevel");
  await zoom.waitFor();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [1920, 1080],
      [1366, 768],
      [1024, 768],
      [768, 1024],
      [420, 844],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      const scales = [1366, 420].includes(width)
        ? [0.8, 1, 1.25, 1.5, 2]
        : width === 320
          ? [1, 2]
          : [1];
      for (const scale of scales) {
        await zoom.selectOption(String(scale));
        await page.reload();
        await delegate.waitFor();
        await hiddenSelection.waitFor();
        const sidebar = page.getByRole("button", {
          name: "显示侧栏",
          exact: true,
        });
        const drawer = await sidebar.isVisible();
        if (drawer) await sidebar.click();
        const metrics = await page.evaluate(() => ({
          dpr: devicePixelRatio,
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
        }));
        assert.equal(metrics.dark, theme === "dark");
        assert.ok(
          Math.abs(metrics.dpr - scale) < 0.02,
          JSON.stringify(metrics),
        );
        assert.ok(
          Math.abs(metrics.width - width / scale) <= 1,
          JSON.stringify(metrics),
        );
        assert.ok(metrics.scroll <= metrics.width + 1, JSON.stringify(metrics));
        if (theme === "dark" && width === 420 && scale === 1) {
          await page.getByRole("button", { name: "展开额度详情" }).click();
          await page.screenshot({
            path: new URL("mobile-dark.png", output).pathname,
          });
        }
        const close = page.getByRole("button", {
          name: "收起侧栏",
          exact: true,
        });
        if (drawer) {
          await close.click();
          await page.waitForFunction(
            () =>
              !document
                .querySelector("#project-sidebar")
                .contains(document.activeElement),
          );
        }
        await openBackendSettings("Antigravity");
        await agy
          .getByRole("checkbox", { name: "Gemini 3.8 Flash", exact: true })
          .waitFor();
        const settingMetrics = await page
          .locator(".settings-body")
          .evaluate((body) => ({
            width: body.clientWidth,
            scroll: body.scrollWidth,
            controls: [
              ...body.querySelectorAll(
                '.backend-card[data-backend="agy"] :is(select,button,input,textarea)',
              ),
            ]
              .filter((control) => control.getClientRects().length)
              .every((control) => {
                const rect = control.getBoundingClientRect();
                const bounds = body.getBoundingClientRect();
                return (
                  rect.x >= bounds.left - 1 && rect.right <= bounds.right + 1
                );
              }),
          }));
        assert.ok(
          settingMetrics.scroll <= settingMetrics.width + 1 &&
            settingMetrics.controls,
          JSON.stringify({ width, height, theme, scale, settingMetrics }),
        );
        if ([1366, 768, 420, 320].includes(width) && [1, 2].includes(scale)) {
          await page
            .locator(".settings-body")
            .evaluate((body) => (body.scrollTop = 0));
          await page.screenshot({
            path: new URL(`settings-${width}-${theme}-${scale}.png`, output)
              .pathname,
          });
        }
        await openSettingsPage(page, "委派模式");
        const roleLayout = await roleEditor.evaluate((editor) => {
          editor.focus();
          const body = editor.closest(".settings-body");
          const rect = editor.getBoundingClientRect();
          const bounds = body.getBoundingClientRect();
          return {
            within: rect.left >= bounds.left && rect.right <= bounds.right + 1,
            focused: editor === document.activeElement,
            fits: body.scrollWidth <= body.clientWidth + 1,
          };
        });
        assert.deepEqual(roleLayout, {
          within: true,
          focused: true,
          fits: true,
        });
        if (width === 420 && [1, 2].includes(scale)) {
          await page.screenshot({
            path: new URL(`role-${width}-${theme}-${scale}.png`, output)
              .pathname,
          });
        }
        if (width === 320 && scale === 2) {
          await openSettingsPage(page, "委派模式");
          const model = delegation.getByLabel("Claude Code 执行模型");
          await model.focus();
          assert(
            await model.evaluate(
              (element) => element === document.activeElement,
            ),
          );
          await page.screenshot({
            path: new URL(
              `settings-${width}-${theme}-${scale}-delegation.png`,
              output,
            ).pathname,
          });
        }
        await page
          .getByRole("button", { name: "关闭窗口", exact: true })
          .click();
      }
    }
  }
  await zoom.selectOption("1");
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.reload();
  await delegate.click();
  await page.getByRole("textbox", { name: "消息", exact: true }).click();
  await page.keyboard.insertText("核对生产配置");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() =>
    window.fixtureRequests.some(
      ({ method, params }) =>
        method === "turn/start" && params.delegateTo === "claude",
    ),
  );
  await page.reload();
  await page.locator(".assistant-message").hover();
  await page.getByRole("button", { name: "从这里继续", exact: true }).click();
  await page.waitForFunction(() =>
    window.fixtureRequests.some(
      ({ method, params }) =>
        method === "thread/fork" && params.lastTurnId === "turn-1",
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Chromium 三后端模型选择恢复、Antigravity 角色设置、委派、审批重试、共享额度、历史及系统主题缩放通过",
  );
} catch (error) {
  console.error({
    errors,
    page: (await page.locator("body").textContent()).slice(0, 1800),
    requests: await page.evaluate(() =>
      window.fixtureRequests?.slice(0, 20).map(({ method }) => method),
    ),
  });
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  throw error;
} finally {
  await context.close();
  listener.close();
  await rm(profile, { recursive: true, force: true });
}
