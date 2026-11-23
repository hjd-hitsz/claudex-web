import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { settingsPage } from "../helpers/settings-navigation.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const build = process.env.BROWSER_BUILD_DIR || join(root, "client/dist");
const output = join(
  root,
  process.env.BROWSER_BEFORE === "1"
    ? ".cache/subagent-save/browser-before"
    : ".cache/subagent-models/browser",
);
await mkdir(output, { recursive: true });
function persistedFixture() {
  const original = window.WebSocket.prototype.send;
  window.WebSocket.prototype.send = function (raw) {
    const message = JSON.parse(raw);
    if (
      window.blockSubagentRefresh &&
      [
        "lan/backends/list",
        "model/list",
        "account/read",
        "config/read",
      ].includes(message.method)
    ) {
      window.unexpectedSubagentRefresh ||= [];
      window.unexpectedSubagentRefresh.push(message.method);
      return;
    }
    if (message.method === "lan/backends/save") {
      if (
        window.failSubagentSave &&
        Object.hasOwn(message.params, "subagentModel")
      ) {
        window.failSubagentSave = false;
        this.onmessage({
          data: JSON.stringify({
            id: message.id,
            error: {
              code: -32000,
              message: "配置写入失败，请重试。",
            },
          }),
        });
        return;
      }
      const saved = JSON.parse(
        sessionStorage.getItem("subagent-backends") || "{}",
      );
      saved[message.params.id] = {
        ...saved[message.params.id],
        ...message.params,
      };
      sessionStorage.setItem("subagent-backends", JSON.stringify(saved));
    }
    return original.call(this, raw);
  };
}
const data = {
  markdown: "子代理模型配置验证",
  claudeItems: [],
  codexModels: [
    ["gpt-6.2-sol", "GPT-6.2-Sol"],
    ["gpt-6.2-astra", "GPT-6.2-Astra"],
    ["gpt-6.1-terra", "GPT-6.1 Terra"],
    ["gpt-6.1-sol", "GPT-6.1-Sol"],
    ["gpt-6-astra", "GPT-6-Astra"],
    ["gpt-6-sol", "GPT-6-Sol"],
    ["gpt-6-luna", "GPT-6-Luna"],
    ["gpt-5.6-sol", "GPT-5.6-Sol"],
    ["gpt-5.6-terra", "GPT-5.6-Terra"],
    ["gpt-5.6-luna", "GPT-5.6-Luna"],
    ["gpt-6.10-luna", "GPT-6.10-Luna"],
    ["gpt-6.3-terra", "GPT-6.3-Terra"],
  ].map(([model, displayName]) => ({ id: model, model, displayName })),
  providers: [
    {
      id: "secondary",
      backendId: "claude",
      name: "另一家供应商",
      models: ["shared-model", "child-model"],
      modelAliases: { "shared-model": "同名模型" },
      modelCapabilities: {
        "shared-model": { supportedEffortLevels: ["low", "high"] },
      },
    },
    {
      id: "third",
      backendId: "claude",
      name: "同名模型供应商",
      models: ["shared-model"],
      modelAliases: { "shared-model": "同名模型" },
    },
  ],
};
const server = http.createServer(async (req, res) => {
  if (serveDemoSession(req, res)) return;
  try {
    const path = new URL(req.url, "http://fixture").pathname;
    let bytes = await readFile(join(build, path === "/" ? "index.html" : path));
    if (path === "/")
      bytes = bytes
        .toString()
        .replace(
          "<head>",
          `<head><script>(${backendFixture.toString()})({...${JSON.stringify(data)},backendSettings:JSON.parse(sessionStorage.getItem("subagent-backends")||"{}")});(${persistedFixture.toString()})()</script>`,
        );
    res
      .writeHead(200, {
        "content-type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
          }[extname(path)] || "text/html",
      })
      .end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "subagent-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1440, height: 1000 },
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
try {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function open() {
    await page.locator(".composer .ProseMirror").waitFor();
    const sidebar = page.getByRole("button", { name: "显示侧栏", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsPage(page, "后端").click();
    await page
      .getByRole("form", { name: "Claude Code 子代理模型", exact: true })
      .waitFor();
  }
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await open();
  const codex = page.getByRole("form", {
    name: "Codex 子代理模型",
    exact: true,
  });
  const claude = page.getByRole("form", {
    name: "Claude Code 子代理模型",
    exact: true,
  });
  const codexCard = page.locator(".backend-card").filter({ has: codex });
  const claudeCard = page.locator(".backend-card").filter({ has: claude });
  const generations = codexCard.getByRole("table", { name: "显示的模型" });
  await generations.waitFor();
  assert.deepEqual(
    await generations.getByRole("columnheader").allTextContents(),
    ["代际", "Astra", "Sol", "Terra", "Luna"],
  );
  assert.deepEqual(await generations.getByRole("rowheader").allTextContents(), [
    "GPT-6.10",
    "GPT-6.3",
    "GPT-6.2",
    "GPT-6.1",
    "GPT-6",
    "GPT-5.6",
  ]);
  const row = generations.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: "GPT-6.2", exact: true }),
  });
  const astra = row.getByRole("cell").nth(0).getByRole("checkbox", {
    name: "ChatGPT/GPT-6.2-Astra",
  });
  const absentTerra = row.getByRole("cell").nth(2);
  assert.equal(await absentTerra.getByRole("checkbox").count(), 0);
  assert.match(await absentTerra.innerText(), /—/);
  const initialWrites = await page.evaluate(
    () =>
      window.fixtureRequests.filter(
        (request) => request.method === "lan/backends/save",
      ).length,
  );
  await absentTerra.click();
  assert.equal(
    await page.evaluate(
      () =>
        window.fixtureRequests.filter(
          (request) => request.method === "lan/backends/save",
        ).length,
    ),
    initialWrites,
  );
  assert.ok(await astra.isChecked());
  await astra.press("Space");
  await astra.and(page.locator("input:not(:checked)")).waitFor();
  assert.ok(await astra.evaluate((input) => input === document.activeElement));
  assert.equal(
    await codex.locator("option").filter({ hasText: "GPT-6.2-Astra" }).count(),
    0,
  );
  await astra.press("Space");
  await astra.and(page.locator("input:checked")).waitFor();
  await codexCard
    .getByRole("checkbox", { name: "ChatGPT/gpt", exact: true })
    .uncheck();
  assert.equal(
    await codex
      .getByLabel("子代理模型", { exact: true })
      .locator("option")
      .filter({ hasText: /^ChatGPT\/gpt$/ })
      .count(),
    0,
  );
  await codex
    .getByLabel("子代理模型", { exact: true })
    .selectOption(JSON.stringify(["", "second"]));
  await codex
    .getByLabel("子代理思考强度", { exact: true })
    .selectOption("high");
  await page.evaluate(() => {
    window.blockSubagentRefresh = true;
  });
  const codexSaveStarted = Date.now();
  await codex.getByRole("button", { name: "保存", exact: true }).click();
  await codex
    .getByRole("button", { name: "保存", exact: true })
    .waitFor({ timeout: 1500 })
    .catch(async (error) => {
      await page.screenshot({ path: join(output, "save-pending.png") });
      throw error;
    });
  const codexSaveMs = Date.now() - codexSaveStarted;
  await page.screenshot({ path: join(output, "save-complete.png") });
  assert.deepEqual(
    await page.evaluate(() => window.unexpectedSubagentRefresh || []),
    [],
  );
  await page.evaluate(() => {
    window.blockSubagentRefresh = false;
  });
  await codexCard
    .getByRole("checkbox", { name: "ChatGPT/Second Model", exact: true })
    .uncheck();
  assert.equal(
    await codex.getByLabel("子代理模型", { exact: true }).inputValue(),
    "unavailable",
  );
  assert.equal(
    await codex
      .getByLabel("子代理模型", { exact: true })
      .locator("option")
      .filter({ hasText: "Second Model" })
      .count(),
    0,
  );
  await page.screenshot({ path: join(output, "hidden-selected-model.png") });
  await codexCard
    .getByRole("checkbox", { name: "ChatGPT/Second Model", exact: true })
    .check();
  assert.equal(
    await codex.getByLabel("子代理模型", { exact: true }).inputValue(),
    JSON.stringify(["", "second"]),
  );
  assert.equal(
    await claude.getByLabel("子代理模型", { exact: true }).inputValue(),
    "",
  );
  await claude
    .getByLabel("子代理模型", { exact: true })
    .selectOption(JSON.stringify(["secondary", "shared-model"]));
  await claude
    .getByLabel("子代理思考强度", { exact: true })
    .selectOption("low");
  await page.evaluate(() => {
    window.failSubagentSave = true;
  });
  await claude.getByRole("button", { name: "保存", exact: true }).click();
  await claude.getByRole("alert").filter({ hasText: "写入失败" }).waitFor();
  assert.equal(
    await claude.getByLabel("子代理思考强度", { exact: true }).inputValue(),
    "low",
  );
  assert.equal(
    await claude.getByLabel("子代理模型", { exact: true }).inputValue(),
    JSON.stringify(["secondary", "shared-model"]),
  );
  await page.evaluate(() => {
    window.blockSubagentRefresh = true;
  });
  const claudeSaveStarted = Date.now();
  await claude.getByRole("button", { name: "保存", exact: true }).click();
  await claude
    .getByRole("button", { name: "保存", exact: true })
    .waitFor({ timeout: 1500 });
  const claudeSaveMs = Date.now() - claudeSaveStarted;
  assert.deepEqual(
    await page.evaluate(() => window.unexpectedSubagentRefresh || []),
    [],
  );
  await page.evaluate(() => {
    window.blockSubagentRefresh = false;
  });
  const claudeModels = claudeCard.getByRole("region", { name: "显示的模型" });
  const hiddenChoice = claudeModels.getByRole("checkbox", {
    name: "另一家供应商/同名模型",
    exact: true,
  });
  const otherChoice = claudeModels.getByRole("checkbox", {
    name: "同名模型供应商/同名模型",
    exact: true,
  });
  const all = claudeModels.getByRole("checkbox", { name: "全选" });
  await hiddenChoice.uncheck();
  assert.equal(
    await claude.getByRole("option", { name: "已选模型已隐藏" }).count(),
    1,
  );
  assert.equal(
    await claude.getByRole("option", { name: "另一家供应商/同名模型" }).count(),
    0,
  );
  assert.equal(
    await claude
      .getByRole("option", { name: "同名模型供应商/同名模型" })
      .count(),
    1,
  );
  assert.ok(await otherChoice.isChecked());
  assert.ok(await all.evaluate((input) => input.indeterminate));
  await claudeModels.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "claude-model-hidden.png") });
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await page
    .getByRole("button", { name: "在当前目录新建对话", exact: true })
    .click();
  const candidates = page.getByLabel("模型", { exact: true }).locator("option");
  assert.ok(
    (await candidates.allTextContents()).includes("同名模型供应商/同名模型"),
  );
  assert.ok(
    !(await candidates.allTextContents()).includes("另一家供应商/同名模型"),
  );
  await page.reload();
  await open();
  await hiddenChoice.waitFor();
  assert.equal(await hiddenChoice.isChecked(), false);
  assert.ok(await otherChoice.isChecked());
  await all.check();
  assert.ok(await hiddenChoice.isChecked());
  await all.uncheck();
  assert.equal(await otherChoice.isChecked(), false);
  await all.check();
  assert.ok(await otherChoice.isChecked());
  await page.reload();
  await open();
  assert.equal(
    await codex
      .getByLabel("子代理模型", { exact: true })
      .locator("option")
      .filter({ hasText: /^ChatGPT\/gpt$/ })
      .count(),
    0,
  );
  assert.equal(
    await codex.getByLabel("子代理思考强度", { exact: true }).inputValue(),
    "high",
  );
  assert.equal(
    await claude.getByLabel("子代理思考强度", { exact: true }).inputValue(),
    "low",
  );
  assert.equal(
    await codex.getByLabel("子代理模型", { exact: true }).inputValue(),
    JSON.stringify(["", "second"]),
  );
  assert.equal(
    await claude.getByLabel("子代理模型", { exact: true }).inputValue(),
    JSON.stringify(["secondary", "shared-model"]),
  );
  const settings = await context.newPage();
  await settings.goto("chrome://settings/appearance");
  const zoom = settings.locator("#zoomLevel");
  const metrics = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.reload();
        await open();
        const layout = await generations.evaluate((table) => ({
          width: table.clientWidth,
          scroll: table.scrollWidth,
          aligned: [...table.tBodies[0].rows].every((row) =>
            [...row.cells].every((cell, col) => {
              const bounds = cell.getBoundingClientRect();
              const header =
                table.tHead.rows[0].cells[col].getBoundingClientRect();
              return Math.abs(bounds.left - header.left) < 1;
            }),
          ),
        }));
        assert.ok(
          layout.aligned && layout.scroll <= layout.width + 1,
          JSON.stringify({ width, theme, scale, layout }),
        );
        await claudeModels.scrollIntoViewIfNeeded();
        const size = await page.locator(".settings-body").evaluate((el) => ({
          width: el.clientWidth,
          scroll: el.scrollWidth,
          dpr: devicePixelRatio,
        }));
        assert.ok(Math.abs(size.dpr - scale) < 0.02);
        assert.ok(
          size.scroll <= size.width + 1,
          JSON.stringify({ width, theme, scale, size }),
        );
        const controls = await claude
          .locator("select, button[type=submit]")
          .evaluateAll((elements) =>
            elements.map((el) => {
              const r = el.getBoundingClientRect();
              return { center: r.top + r.height / 2, width: r.width };
            }),
          );
        assert.ok(
          controls.every(
            (control) =>
              Math.abs(control.center - controls[0].center) < 1 &&
              control.width > 0,
          ),
          JSON.stringify({ width, scale, controls }),
        );
        assert.ok(
          await claude
            .getByRole("button", { name: "保存", exact: true })
            .isVisible(),
        );
        await page.screenshot({
          path: join(output, `${width}-${theme}-${scale}.png`),
        });
        metrics.push({ width, theme, scale, ...size });
      }
    }
  }
  await zoom.selectOption("1");
  await page.reload();
  await open();
  await claude.getByLabel("子代理模型", { exact: true }).selectOption("");
  await claude.getByRole("button", { name: "保存", exact: true }).click();
  await claude.getByRole("button", { name: "保存", exact: true }).waitFor();
  await page.reload();
  await open();
  assert.equal(
    await claude.getByLabel("子代理模型", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await codex.getByLabel("子代理模型", { exact: true }).inputValue(),
    JSON.stringify(["", "second"]),
  );
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("/model");
  await composer.press("Control+Enter");
  const modelDialog = page.getByRole("dialog", { name: "模型与思考强度" });
  await modelDialog
    .getByRole("button", { name: /^ChatGPT\/Second Model/ })
    .waitFor();
  assert.equal(
    await modelDialog.getByRole("button", { name: /^ChatGPT\/gpt$/ }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      {
        checks: [
          "independent backend settings",
          "Codex hidden models excluded and restored",
          "Codex generation order, fixed tier columns, unavailable models and keyboard toggling",
          "model command uses the same hidden model settings",
          "per-model effort choices and persistence",
          "cross-provider selection",
          "write failure retains form",
          "save completes while unrelated catalogue reads are blocked",
          "retry",
          "refresh",
          "clear",
          "themes",
          "browser zoom",
          "narrow sidebar",
        ],
        metrics,
        codexSaveMs,
        claudeSaveMs,
        build: JSON.parse(
          await readFile(join(root, "build-info.json"), "utf8"),
        ),
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS 子代理模型独立保存、跨供应商、失败重试、刷新恢复、深浅主题、实际缩放与窄屏",
  );
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
