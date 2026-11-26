import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { defaultSecretaryRole as builtIn } from "../../server/src/backends/agy/secretary-prompts.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { openSettingsPage } from "../helpers/settings-navigation.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, ".cache/delegation-refinement/browser");
const customDefault = builtIn.trimEnd() + "\n\n请在交付时附上核对过的材料。\n";
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "claudex-delegation-browser-"));
const serve = createStaticHandler(
  process.env.BROWSER_BUILD_DIR || join(root, "client/dist"),
);
const server = createServer((request, response) => {
  if (serveDemoSession(request, response)) return;
  return serve(
    request,
    response,
    new URL(request.url, "http://local").pathname,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const desktop = { width: 1440, height: 960 };
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  viewport: desktop,
  headless: true,
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
try {
  await page.addInitScript(backendFixture, {
    main: true,
    retainStorageOnReload: true,
    nativeDelegation: true,
    delegationDefaultPrompt: builtIn,
    markdown: "请在测试工作区核对版本配置。",
    claudeItems: [],
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("http://127.0.0.1:" + server.address().port);
  const composer = page.locator(".composer .ProseMirror");
  const switchMode = page
    .getByRole("button", { name: "委派模式", exact: true })
    .and(page.locator(".composer button"));
  const open = page.getByRole("button", { name: "设置", exact: true });
  const close = page.getByRole("button", { name: "关闭窗口", exact: true });
  const form = page.getByRole("form", { name: "委派模式" });
  const promptName = form.getByLabel("名称", { exact: true });
  const promptText = form.getByLabel("提示词正文", { exact: true });
  const prompts = form.getByRole("combobox", { name: "选择要编辑的提示词" });
  const defaultPrompt = form.getByRole("textbox", { name: "默认提示词正文" });
  const save = form.getByRole("button", { name: "保存委派设置" });
  const openDelegation = async () => {
    if (!(await open.isVisible()))
      await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
    await open.click();
    await openSettingsPage(page, "委派模式");
    await form.waitFor();
  };
  const screenshot = (name) =>
    page.screenshot({
      path: join(output, name + ".png"),
      animations: "disabled",
    });
  await composer.waitFor();
  await openDelegation();
  await defaultPrompt.waitFor();
  assert.deepEqual(
    await form.getByRole("heading", { level: 3 }).allTextContents(),
    ["接收委派", "发起委派", "提示词预设"],
  );
  await form.getByRole("checkbox", { name: "Codex 接收委派" }).focus();
  await page.keyboard.press("Tab");
  assert(
    await form
      .getByLabel("Codex 执行模型")
      .evaluate((control) => control === document.activeElement),
  );
  await form.getByRole("checkbox", { name: "Codex 接收委派" }).check();
  await form.getByRole("checkbox", { name: "Claude Code 接收委派" }).check();
  assert.equal(await defaultPrompt.inputValue(), builtIn);
  assert.equal(
    await page
      .locator(
        ".settings-navigation button[aria-current=page] svg.lucide-forward",
      )
      .count(),
    1,
  );
  await defaultPrompt.fill(customDefault);
  await form.getByRole("button", { name: "保存默认提示词" }).click();
  await form.getByText("默认提示词已保存").waitFor();
  await screenshot("00-current-default");
  async function add(name, body) {
    await form.getByRole("button", { name: "新增", exact: true }).click();
    assert.equal(await promptText.inputValue(), customDefault);
    await promptName.fill(name);
    await promptText.fill(body);
    return prompts.inputValue();
  }
  const codex = await add("代码验证", "逐项核对变更，报告测试与证据。");
  const claude = await add("文档核对", "阅读相关文件，列出具体位置和结论。");
  const secretaryPreset = await add("秘书交接", "汇总发起会话的委派结果。");
  const secretary = form.getByRole("combobox", {
    name: "Antigravity 发起提示词",
  });
  await secretary.selectOption(secretaryPreset);
  const custom = form.getByRole("combobox", {
    name: "Codex 发起提示词",
    exact: true,
  });
  const second = form.getByRole("combobox", {
    name: "Claude Code 发起提示词",
    exact: true,
  });
  await custom.selectOption(codex);
  await second.selectOption(claude);
  await form
    .getByRole("combobox", { name: "Codex 执行模型", exact: true })
    .selectOption(JSON.stringify(["", "gpt"]));
  await form
    .getByRole("combobox", { name: "Claude Code 执行模型", exact: true })
    .selectOption(JSON.stringify(["", "sonnet"]));
  await form
    .getByRole("combobox", { name: "Codex 执行思考强度", exact: true })
    .selectOption("high");
  await form
    .getByRole("combobox", { name: "Claude Code 执行思考强度", exact: true })
    .selectOption("low");
  await save.click();
  await form.getByText("委派设置已保存").waitFor();
  await screenshot("01-settings-desktop-light");
  await page.reload();
  await composer.waitFor();
  await openDelegation();
  assert.equal(await custom.inputValue(), codex);
  assert.equal(await second.inputValue(), claude);
  assert.equal(await secretary.inputValue(), secretaryPreset);
  await defaultPrompt.waitFor();
  assert(
    await form.getByRole("checkbox", { name: "Codex 接收委派" }).isChecked(),
  );
  assert(
    await form
      .getByRole("checkbox", { name: "Claude Code 接收委派" })
      .isChecked(),
  );
  assert.equal(await defaultPrompt.inputValue(), customDefault);
  assert.equal(
    await form
      .getByRole("combobox", { name: "Codex 执行思考强度", exact: true })
      .inputValue(),
    "high",
  );
  assert.equal(
    await form
      .getByRole("combobox", { name: "Claude Code 执行思考强度", exact: true })
      .inputValue(),
    "low",
  );
  await prompts.selectOption(codex);
  await promptName.fill("回归验证");
  await promptText.fill("核对测试日志并提供文件位置。");
  await prompts.selectOption(claude);
  await form.getByRole("button", { name: "删除提示词", exact: true }).click();
  assert.equal(await second.inputValue(), "");
  assert.equal(await secretary.inputValue(), secretaryPreset);
  await save.click();
  await form.getByText("委派设置已保存").waitFor();
  await prompts.selectOption(codex);
  assert.equal(await promptName.inputValue(), "回归验证");
  assert.equal(await promptText.inputValue(), "核对测试日志并提供文件位置。");
  await close.click();

  const collapsed = page.locator(
    '.project-heading > button[aria-expanded="false"]',
  );
  while (await collapsed.count()) await collapsed.first().click();
  const claudeThread = page
    .locator(".sidebar")
    .getByText("Claude 原生消息归属", {
      exact: true,
    });
  const codexThread = page
    .locator(".sidebar")
    .getByText("旧版未分类与 Markdown", {
      exact: true,
    });
  async function send(expected, text) {
    await composer.fill(text);
    await page.locator(".composer .send-button").click();
    await page.waitForFunction(
      (body) =>
        window.fixtureRequests.some(
          ({ method, params }) =>
            method === "turn/start" && params.input[0].text === body,
        ),
      text,
    );
    const params = await page.evaluate(
      (body) =>
        window.fixtureRequests.find(
          ({ method, params }) =>
            method === "turn/start" && params.input[0].text === body,
        ).params,
      text,
    );
    assert.equal(params.delegationMode, expected);
    return params;
  }
  assert.equal(await switchMode.locator("svg.lucide-forward").count(), 1);
  assert.equal(await switchMode.getAttribute("aria-pressed"), "false");
  await switchMode.focus();
  await page.keyboard.press("Enter");
  assert.equal(await switchMode.getAttribute("aria-pressed"), "true");
  await screenshot("02-codex-composer");
  await send(true, "Codex 双向委派验收");
  await claudeThread.click();
  await page.locator('.composer button[title="委派模式 · Codex"]').waitFor();
  assert.equal(await switchMode.getAttribute("aria-pressed"), "false");
  await switchMode.click();
  assert.equal(await switchMode.getAttribute("aria-pressed"), "true");
  await screenshot("03-claude-composer");
  await send(true, "Claude 双向委派验收");
  await codexThread.click();
  await page
    .locator(
      '.composer button[title="委派模式 · Claude Code"][aria-pressed=true]',
    )
    .waitFor();
  await switchMode.click();
  await send(undefined, "关闭委派模式验收");

  await claudeThread.click();
  await page.getByRole("button", { name: "在当前目录新建对话" }).click();
  await page.locator('.composer button[title="委派模式 · Codex"]').waitFor();
  assert.equal(await switchMode.getAttribute("aria-pressed"), "false");
  await switchMode.click();
  await page.locator('.composer input[type="file"]').setInputFiles({
    name: "fixture.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgAB9HFkpgAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await page
    .getByRole("button", { name: "预览 fixture.png", exact: true })
    .waitFor();
  const first = await send(true, "新建 Claude 对话首轮带图委派");
  assert.equal(first.threadId, "backend:claude:new-delegation");
  assert(
    first.input.some(
      ({ type, url }) => type === "image" && url.startsWith("data:image/png;"),
    ),
  );
  await screenshot("04-claude-first-image-delegation");
  await codexThread.click();

  const zoomPage = await context.newPage();
  await zoomPage.goto("chrome://settings/appearance");
  const zoom = zoomPage.locator("#zoomLevel");
  await zoom.waitFor();
  const results = [];
  for (const size of [desktop, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.reload();
        await composer.waitFor();
        await openDelegation();
        assert.deepEqual(
          await form.getByRole("heading", { level: 3 }).allTextContents(),
          ["接收委派", "发起委派", "提示词预设"],
        );
        await prompts.selectOption(codex);
        const metrics = await form.evaluate((node) => ({
          dpr: devicePixelRatio,
          width: innerWidth,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          theme: getComputedStyle(document.documentElement).colorScheme,
        }));
        assert(Math.abs(metrics.dpr - scale) < 0.02);
        assert(Math.abs(metrics.width - size.width / scale) <= 1);
        assert(
          metrics.scrollWidth <= metrics.clientWidth + 1,
          JSON.stringify(metrics),
        );
        assert.equal(metrics.theme, theme);
        assert.equal(await custom.inputValue(), codex);
        if (scale === 1 || scale === 2)
          await screenshot(
            size.width + "-" + theme + "-" + scale + "-settings",
          );
        await close.click();
        const hide = page.getByRole("button", {
          name: "收起侧栏",
          exact: true,
        });
        if (size.width === 390 && (await hide.isVisible())) {
          await hide.click();
          await hide.waitFor({ state: "hidden" });
          await open.waitFor({ state: "hidden" });
        }
        await switchMode.focus();
        assert(
          await switchMode.evaluate((node) => node === document.activeElement),
        );
        const bounds = await switchMode.boundingBox();
        assert(
          bounds &&
            bounds.x >= 0 &&
            bounds.x + bounds.width <= metrics.width + 1,
        );
        results.push({ ...size, theme, scale, ...metrics, toggle: bounds });
        if (size.width === 390 && scale === 1)
          await screenshot("390-" + theme + "-composer");
      }
    }
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await zoom.selectOption("2");
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await page.reload();
    await composer.waitFor();
    await openDelegation();
    await defaultPrompt.focus();
    const layout = await defaultPrompt.evaluate((editor) => {
      const body = editor.closest(".settings-body");
      const viewport = body.getBoundingClientRect();
      const rect = editor.getBoundingClientRect();
      return {
        dpr: devicePixelRatio,
        width: innerWidth,
        focused: document.activeElement === editor,
        within: rect.left >= viewport.left && rect.right <= viewport.right + 1,
        fits: body.scrollWidth <= body.clientWidth + 1,
      };
    });
    assert.deepEqual(layout, {
      dpr: 2,
      width: 160,
      focused: true,
      within: true,
      fits: true,
    });
    await screenshot("320-" + theme + "-2-default-prompt");
  }
  await zoom.selectOption("1");
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(
    "PASS 默认正文编辑和保存、复制新建、三端预设绑定、删除回退与刷新；双端新图标与发送",
  );
  console.log(
    "PASS 桌面、窄屏、深浅主题及 80–200% 的 20 组 Chromium 缩放及 320 像素视口 200% 下的默认提示词焦点",
  );
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  throw error;
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
