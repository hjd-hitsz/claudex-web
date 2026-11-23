import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { settingsPage } from "../helpers/settings-navigation.mjs";
const catalogue = process.env.OPENCODE_MODEL_CATALOGUE
  ? JSON.parse(await readFile(process.env.OPENCODE_MODEL_CATALOGUE, "utf8"))
  : null;
const output = join(
  process.cwd(),
  catalogue
    ? ".cache/opencode/real-models"
    : ".cache/opencode/backend-selection",
);
await mkdir(output, { recursive: true });
const data = {
  opencode: true,
  opencodeModels: [
    {
      id: "openai/gpt-6-luna",
      model: "openai/gpt-6-luna",
      displayName: "GPT-6 Luna",
      providerName: "ChatGPT",
      supportedReasoningEfforts: ["low", "high"].map((reasoningEffort) => ({
        reasoningEffort,
      })),
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "priority", name: "Fast" }],
    },
    {
      id: "claudex-fixture/atlas-code",
      model: "claudex-fixture/atlas-code",
      displayName: "Atlas Code",
      providerName: "Atlas 示例服务",
      supportedReasoningEfforts: [],
    },
  ],
  providers: [
    {
      id: "deepseek",
      backendId: "claude",
      preset: true,
      enabled: false,
      name: "DeepSeek",
      icon: "deepseek",
      hasApiKey: false,
      models: [],
    },
    {
      id: "fixture",
      backendId: "claude",
      name: "Atlas 示例服务",
      protocol: "anthropic",
      baseUrl: "https://example.org/anthropic",
      models: ["atlas-code"],
      modelAliases: { "atlas-code": "Atlas Code" },
    },
  ],
  markdown: "三后端隔离验证",
  claudeItems: [],
  backendInstallations: Object.fromEntries(
    ["codex", "claude", "opencode"].map((id) => [
      id,
      {
        installed: true,
        currentVersion: id === "opencode" ? "2.3.2" : "1.0.0",
        latestVersion: id === "opencode" ? "2.3.2" : "1.0.0",
      },
    ]),
  ),
};
if (catalogue) {
  const selected =
    catalogue.models.find(
      (model) => model.providerName === "ChatGPT" && model.isDefault,
    ) || catalogue.models.find((model) => model.providerName === "ChatGPT");
  assert.ok(selected, "原生目录必须提供待展示的订阅模型。");
  data.opencodeModels = [
    selected,
    ...catalogue.models.filter((model) => model !== selected),
  ];
  data.providers = catalogue.providers;
}
const selectedModel = data.opencodeModels[0];
const hiddenModel = data.opencodeModels.at(-1);
const server = http.createServer(async (req, res) => {
  if (serveDemoSession(req, res)) return;
  try {
    const requested = new URL(req.url, "http://fixture");
    const path = requested.pathname;
    let bytes = await readFile(
      join(process.cwd(), "client/dist", path === "/" ? "index.html" : path),
    );
    if (path === "/")
      bytes = bytes
        .toString()
        .replace(
          "<head>",
          `<head><script>(${backendFixture.toString()})(${JSON.stringify({ ...data, theme: requested.searchParams.get("theme") || "light" })})</script>`,
        );
    res
      .writeHead(200, {
        "content-type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
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
const profile = await mkdtemp(join(tmpdir(), "opencode-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"],
});
const errors = [];
async function openBackends(page) {
  const settings = page.getByRole("button", { name: "设置", exact: true });
  const showSidebar = page.getByRole("button", {
    name: "显示侧栏",
    exact: true,
  });
  if (
    (await showSidebar.isVisible()) &&
    !(await page.locator(".sidebar.mobile-open").count())
  )
    await showSidebar.click();
  await settings.click();
  await settingsPage(page, "后端").click();
}
async function closeSettings(page) {
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  if (await page.locator(".sidebar.mobile-open").count())
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
}
function modelCheckbox(page, backend, name) {
  return page
    .locator(".backend-card")
    .filter({ has: page.locator("strong", { hasText: backend }) })
    .getByRole("checkbox", { name, exact: true });
}
async function verifyVisibility(page, screenshotPrefix) {
  const entries = [
    ["codex", "Codex", "Second Model", "second"],
    ["claude", "Claude Code", "Second Model", "second"],
    ["opencode", "OpenCode", hiddenModel.displayName, hiddenModel.model],
  ];
  await openBackends(page);
  for (const name of ["Claude Code", "OpenCode"]) {
    const card = page.locator(".backend-card").filter({
      has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }),
    });
    const all = card.getByRole("checkbox", { name: "全选", exact: true });
    const options = card.locator(
      '.codex-model-settings li input[type="checkbox"]',
    );
    await all.uncheck();
    assert.ok((await options.count()) > 1);
    assert.equal(
      await options.evaluateAll((nodes) => nodes.some((node) => node.checked)),
      false,
    );
    await all.check();
    assert.equal(
      await options.evaluateAll((nodes) => nodes.every((node) => node.checked)),
      true,
    );
    await options.first().uncheck();
    assert.equal(await all.evaluate((node) => node.indeterminate), true);
    await all.check();
    await card.screenshot({
      path: join(output, `${screenshotPrefix}-${name}-select-all.png`),
    });
    await closeSettings(page);
    await openBackends(page);
    assert.equal(await all.isChecked(), true);
  }
  await modelCheckbox(page, /^Codex$/, "Second Model").uncheck();
  assert.equal(
    await modelCheckbox(page, /^Claude Code$/, "Second Model").isChecked(),
    true,
  );
  await modelCheckbox(page, /^Claude Code$/, "Second Model").uncheck();
  await modelCheckbox(page, /^OpenCode$/, hiddenModel.displayName).uncheck();
  await page.screenshot({
    animations: "disabled",
    path: join(output, `${screenshotPrefix}-model-settings.png`),
  });
  await closeSettings(page);
  for (const [id, name, label, hiddenModel] of entries) {
    await page.getByRole("button", { name: /^切换后端，当前为/ }).click();
    await page
      .getByRole("group", { name: "后端", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
    await page
      .getByRole("button", { name: `切换后端，当前为 ${name}`, exact: true })
      .waitFor();
    const select = page.getByRole("combobox", { name: "模型", exact: true });
    const values = await select
      .locator("option:not(:disabled)")
      .evaluateAll((options) => options.map((o) => JSON.parse(o.value)));
    assert.ok(
      values.length &&
        values.every(
          ([backendId, , model]) => backendId === id && model !== hiddenModel,
        ),
    );
    await openBackends(page);
    const checkbox = modelCheckbox(page, new RegExp(`^${name}$`), label);
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    await closeSettings(page);
    await page.waitForFunction(
      ({ id, hiddenModel }) =>
        [...document.querySelector('select[aria-label="模型"]').options].some(
          (option) => {
            if (option.disabled) return false;
            const value = JSON.parse(option.value);
            return value[0] === id && value[2] === hiddenModel;
          },
        ),
      { id, hiddenModel },
    );
  }
}
try {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(10000);
  const appearance = await context.newPage();
  await appearance.goto("chrome://settings/appearance");
  const zoom = appearance.locator("#zoomLevel");
  await zoom.waitFor();
  const metrics = [];
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"])
      for (const scale of process.env.BROWSER_QUICK
        ? [1]
        : [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        console.log(JSON.stringify({ width, theme, scale }));
        await page.bringToFront();
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(
          `http://127.0.0.1:${server.address().port}/?theme=${theme}`,
        );
        await page.locator(".composer .ProseMirror").waitFor();
        if (
          !(await page
            .getByRole("button", { name: "设置", exact: true })
            .isVisible())
        )
          await page
            .getByRole("button", { name: "显示侧栏", exact: true })
            .click();
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await settingsPage(page, "后端").click();
        const card = page
          .locator(".backend-card")
          .filter({ has: page.locator("strong", { hasText: /^OpenCode$/ }) });
        await card.scrollIntoViewIfNeeded();
        assert.equal(await page.locator(".backend-card").count(), 3);
        assert.equal(
          await card.getByText("ChatGPT", { exact: false }).count(),
          0,
        );
        const toggle = card.getByRole("checkbox", { name: "启用 OpenCode" });
        await toggle.uncheck();
        await card
          .getByRole("status", { name: "已停用", exact: true })
          .waitFor();
        await toggle.check();
        await card
          .getByRole("status", { name: "已连接", exact: true })
          .waitFor();
        await settingsPage(page, "模型服务商").click();
        await page
          .getByText(data.providers.at(-1).name, { exact: true })
          .waitFor();
        assert.equal(
          await page.getByText("ChatGPT 订阅", { exact: true }).count(),
          0,
        );
        assert.equal(await page.locator(".subscription-account").count(), 0);
        await page.screenshot({
          animations: "disabled",
          path: join(output, `${width}-${theme}-${scale}-providers.png`),
        });
        await page
          .getByRole("button", { name: "关闭窗口", exact: true })
          .click();
        if (await page.locator(".sidebar.mobile-open").count())
          await page
            .getByRole("button", { name: "收起侧栏", exact: true })
            .click();
        await page.getByRole("button", { name: /^切换后端，当前为/ }).click();
        await page.getByRole("group", { name: "后端", exact: true }).waitFor();
        await page.screenshot({
          animations: "disabled",
          path: join(output, `${width}-${theme}-${scale}-switcher.png`),
        });
        await page
          .getByRole("group", { name: "后端", exact: true })
          .getByRole("button", { name: "OpenCode", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: "切换后端，当前为 OpenCode",
            exact: true,
          })
          .waitFor();
        await page.waitForFunction(
          (model) =>
            document.querySelector('select[aria-label="模型"]').value ===
            JSON.stringify(["opencode", "", model]),
          selectedModel.model,
        );
        assert.equal(
          await page.locator(".model-select-value").textContent(),
          `${selectedModel.providerName}/${selectedModel.displayName}`,
        );
        const labels = await page
          .getByRole("combobox", { name: "模型", exact: true })
          .locator("option:not(:disabled)")
          .allTextContents();
        assert.deepEqual(
          labels,
          data.opencodeModels.map(
            (model) => `${model.providerName}/${model.displayName}`,
          ),
        );
        for (const label of labels)
          assert.equal(label.includes(" · "), false, label);
        const speed = page.getByRole("button", {
          name: "速度模式",
          exact: true,
        });
        assert.equal(await speed.isEnabled(), true);
        await speed.click();
        assert.equal(await speed.getAttribute("aria-pressed"), "true");
        assert.match(await speed.getAttribute("title"), /Fast/);
        const effort = page.locator(".reasoning-effort-trigger");
        assert.equal(await effort.isEnabled(), true);
        await effort.click();
        const slider = page.getByRole("slider");
        await slider.focus();
        await page.keyboard.press("End");
        await page.screenshot({
          path: join(output, `${width}-${theme}-${scale}-model-controls.png`),
        });
        await effort.click();
        await speed.click();
        assert.equal(await speed.getAttribute("aria-pressed"), "false");
        assert.equal(
          await page.locator(".account-button b").textContent(),
          "OpenCode",
        );
        const options = await page
          .getByRole("combobox", { name: "模型", exact: true })
          .locator("option")
          .evaluateAll((nodes) =>
            nodes.filter((n) => !n.disabled).map((n) => JSON.parse(n.value)[0]),
          );
        assert.ok(options.length && options.every((id) => id === "opencode"));
        await page.screenshot({
          animations: "disabled",
          path: join(output, `${width}-${theme}-${scale}-selected.png`),
        });
        if (catalogue && scale === 1) {
          const select = page.getByRole("combobox", {
            name: "模型",
            exact: true,
          });
          await page.locator(".composer").screenshot({
            animations: "disabled",
            path: join(output, `${width}-${theme}-composer.png`),
          });
          await select.click();
          await page.screenshot({
            animations: "disabled",
            path: join(output, `${width}-${theme}-model-menu.png`),
          });
          await page.keyboard.press("Escape");
          for (const model of data.opencodeModels) {
            await select.selectOption(
              JSON.stringify(["opencode", "", model.model]),
            );
            assert.equal(
              await page.locator(".model-select-value").textContent(),
              `${model.providerName}/${model.displayName}`,
            );
          }
          await page.locator(".composer").screenshot({
            animations: "disabled",
            path: join(output, `${width}-${theme}-provider-composer.png`),
          });
          await select.selectOption(
            JSON.stringify(["opencode", "", selectedModel.model]),
          );
        }
        const bounds = await page.evaluate(() => ({
          width: innerWidth,
          dpr: devicePixelRatio,
          scrollWidth: document.documentElement.scrollWidth,
          theme: document.documentElement.dataset.theme,
        }));
        assert.ok(bounds.scrollWidth <= bounds.width + 1);
        metrics.push({ width, theme, scale, ...bounds });
        if (scale === 1)
          await verifyVisibility(page, `${width}-${theme}-${scale}`);
        if (width === 390) {
          const show = page.getByRole("button", {
            name: "显示侧栏",
            exact: true,
          });
          if (!(await page.locator(".sidebar.mobile-open").count()))
            await show.click();
          await page
            .getByRole("button", { name: "收起侧栏", exact: true })
            .click();
          assert.equal(
            await page
              .locator(".sidebar")
              .evaluate((el) => el.contains(document.activeElement)),
            false,
          );
        }
      }
  await zoom.selectOption("1");
  assert.deepEqual(errors, []);
  await (
    await import("node:fs/promises")
  ).writeFile(join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
  console.log(
    `OpenCode 浏览器验收通过：${metrics.length} 个主题、视口与缩放组合`,
  );
} catch (error) {
  const page = context
    .pages()
    .find((page) => page.url().startsWith("http://127.0.0.1"));
  if (page) {
    await page.screenshot({
      path: join(output, "failure.png"),
      fullPage: true,
    });
    console.error(
      "Visible model:",
      await page.locator(".model-select-value").textContent(),
    );
  }
  throw error;
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
