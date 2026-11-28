import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  settingsPage,
  switchComposerBackend,
} from "../helpers/settings-navigation.mjs";
import http from "node:http";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.UI_BEFORE === "1";
const build = process.env.UI_BUILD_DIR || join(root, "client/dist");
const output = join(
  root,
  ".cache/provider-model-aliases",
  before ? "before" : "dual",
);
await mkdir(output, { recursive: true });
const model =
  "provider/team/very-long-custom-model-identifier-for-alias-testing";
const models = [
  model,
  ...Array.from({ length: 9 }, (_, i) => `model-${i + 2}`),
];
const data = {
  markdown: "供应商模型设置测试",
  claudeItems: [],
  providers: [
    {
      id: "deepseek",
      backendId: "claude",
      name: "DeepSeek",
      icon: "deepseek",
      preset: true,
      hasApiKey: true,
      models: ["deepseek-flash"],
    },
    {
      id: "vendor",
      backendId: "claude",
      name: "示例供应商",
      baseUrl: "https://example.org",
      protocol: "messages_compatible",
      hasApiKey: true,
      models,
      modelAliases: { [model]: "SenseNova Loop 9B" },
      modelCapabilities: {
        [model]: {
          contextWindow: 196608,
          supportedEffortLevels: ["medium"],
          supportsAdaptiveThinking: true,
        },
      },
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
          `<head><script>(${backendFixture.toString()})(${JSON.stringify(data)})</script>`,
        );
    res
      .writeHead(200, {
        "Content-Type":
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
const profile = await mkdtemp(join(tmpdir(), "backend-ui-"));
const context = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1440, height: 1000 },
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: [
    "--no-sandbox",
    "--no-proxy-server",
    "--disable-gpu",
    "--disable-dev-shm-usage",
  ],
});
try {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(".composer .ProseMirror").waitFor();
  await page
    .getByRole("button", { name: /^新对话/ })
    .first()
    .click();
  if (!before) await switchComposerBackend(page, "Claude Code");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  if (!before) await settingsPage(page, "模型服务商").click();
  await page.locator(".provider-settings").waitFor();
  const row = page
    .locator(".backend-heading")
    .filter({ hasText: "示例供应商" });
  const edit = row.getByRole("button", { name: "编辑", exact: true });
  const remove = row.getByRole("button", { name: "删除", exact: true });
  const form = page.locator(".provider-settings .backend-form");
  const save = form.getByRole("button", { name: "保存供应商", exact: true });
  const add = page.getByRole("button", { name: "添加供应商" });
  await row.waitFor();
  await page.locator(".provider-settings").screenshot({
    path: join(output, "provider-actions.png"),
  });
  await edit.click();
  if (before) {
    const name = await form.getByLabel("名称", { exact: true }).boundingBox();
    const protocol = await form.getByLabel("API 协议").boundingBox();
    const key = await form.getByLabel("API Key", { exact: true }).boundingBox();
    const clear = await form
      .getByRole("checkbox", { name: "清除已保存凭据" })
      .boundingBox();
    assert.ok(protocol.y > name.y + name.height);
    assert.ok(clear.y > key.y + key.height);
    await form.screenshot({ path: join(output, "provider-fields.png") });
  } else {
    const protocol = form.getByLabel("API 协议");
    assert.equal(await protocol.inputValue(), "messages_compatible");
    assert.deepEqual(await protocol.getByRole("option").allTextContents(), [
      "Message API",
      "Message API（兼容）",
    ]);
    assert.match(
      await protocol.getAttribute("aria-describedby"),
      /provider-protocol-help/,
    );
    assert.equal(await edit.getAttribute("aria-expanded"), "true");
    assert.ok(
      await row.evaluate((el) =>
        el.nextElementSibling?.matches(".provider-editor"),
      ),
    );
    assert.equal(
      await page
        .locator(".settings-page-heading")
        .getByRole("button", {
          name: "添加供应商",
          exact: true,
        })
        .count(),
      1,
    );
    await page.locator(".provider-settings").screenshot({
      path: join(output, "provider-editor.png"),
    });
    const fields = form.locator(".provider-fields");
    const credentials = form.locator(".provider-credentials");
    const keyField = credentials.getByLabel("API Key", { exact: true });
    const clearKey = credentials.getByRole("checkbox", {
      name: "清除已保存凭据",
    });
    await fields.screenshot({ path: join(output, "provider-fields.png") });
    const modelList = form.getByRole("region", { name: "模型参数" });
    const picker = modelList.getByRole("combobox", { name: "配置模型" });
    const contextLength = modelList.getByLabel("上下文容量", { exact: true });
    const contextUnit = modelList.getByRole("button", { name: "按 k 输入" });
    const alias = modelList.getByLabel("显示别名", { exact: true });
    const effort = modelList.getByRole("group", { name: "思考强度" });
    const editBox = await edit.boundingBox();
    const removeBox = await remove.boundingBox();
    const rowBox = await row.boundingBox();
    assert.equal(editBox.y, removeBox.y);
    assert.ok(removeBox.x - editBox.x - editBox.width < 10);
    assert.ok(
      Math.abs(rowBox.x + rowBox.width - removeBox.x - removeBox.width) < 1,
    );
    assert.deepEqual(
      await picker.getByRole("option").allTextContents(),
      models,
    );
    assert.equal(await picker.inputValue(), model);
    assert.equal(await alias.count(), 1);
    assert.equal(await contextLength.count(), 1);
    assert.equal(await effort.count(), 1);
    assert.equal(await contextLength.inputValue(), "196608");
    assert.equal(await contextUnit.textContent(), "k");
    assert.equal(await contextUnit.getAttribute("aria-pressed"), "false");
    assert.equal(
      await contextUnit.getAttribute("title"),
      "按 k 输入（1k = 1024 tokens）",
    );
    assert.equal(await modelList.locator("p").count(), 0);
    await contextUnit.click();
    assert.equal(await contextLength.inputValue(), "192");
    assert.equal(await contextUnit.getAttribute("aria-pressed"), "true");
    assert.equal(await contextUnit.getAttribute("title"), "切回完整数字");
    await contextUnit.click();
    await contextLength.fill("200000");
    await contextUnit.click();
    assert.equal(await contextLength.inputValue(), "195.3125");
    await contextUnit.click();
    assert.equal(await contextLength.inputValue(), "200000");
    await contextLength.fill("262144");
    assert.equal(await alias.inputValue(), "SenseNova Loop 9B");
    await alias.fill("日常模型");
    assert.equal(await picker.locator("option:checked").textContent(), model);
    await contextLength.press("Tab");
    await contextUnit.press("Tab");
    const low = effort.getByRole("checkbox", { name: "low", exact: true });
    assert.ok(
      await low.evaluate(
        (el) => el === document.activeElement && el.matches(":focus-visible"),
      ),
    );
    await low.press("Space");
    await effort.getByText("max", { exact: true }).click();
    await effort.getByText("medium", { exact: true }).click();
    await modelList.getByLabel("支持快速模式").check();
    await picker.selectOption(models[1]);
    assert.equal(await alias.inputValue(), "");
    assert.equal(await contextLength.inputValue(), "");
    assert.equal(await low.isChecked(), false);
    await alias.fill("第二个模型");
    assert.deepEqual(
      await picker.getByRole("option").allTextContents(),
      models,
    );
    await contextLength.fill("32k");
    await picker.selectOption(model);
    await save.click();
    await form.getByRole("alert").filter({ hasText: "model-2" }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        fixtureRequests.some((r) => r.method === "lan/providers/save"),
      ),
      false,
    );
    await picker.selectOption(models[1]);
    assert.equal(await contextLength.inputValue(), "32k");
    await contextLength.fill("");
    await contextUnit.click();
    await contextLength.fill("32");
    await picker.selectOption(models[2]);
    assert.equal(await contextUnit.getAttribute("aria-pressed"), "false");
    await contextUnit.click();
    await contextLength.fill("192");
    await picker.selectOption(model);
    assert.equal(await alias.inputValue(), "日常模型");
    assert.ok(await low.isChecked());
    assert.ok(await effort.getByRole("checkbox", { name: "max" }).isChecked());
    const height = await modelList.evaluate((el) => el.offsetHeight);
    await page.evaluate(() => {
      const original = window.backendSocket.send.bind(window.backendSocket);
      window.backendSocket.send = (raw) => {
        const request = JSON.parse(raw);
        if (request.method === "lan/providers/save") {
          window.backendSocket.send = original;
          window.backendSocket.onmessage({
            data: JSON.stringify({
              id: request.id,
              error: { code: -1, message: "模拟保存失败" },
            }),
          });
        } else original(raw);
      };
    });
    await save.click();
    await page.getByRole("alert").filter({ hasText: "模拟保存失败" }).waitFor();
    assert.equal(await alias.inputValue(), "日常模型");
    assert.equal(await contextLength.inputValue(), "262144");
    assert.ok(await low.isChecked());
    await picker.selectOption(models[1]);
    assert.equal(await contextLength.inputValue(), "32");
    assert.equal(await contextUnit.getAttribute("aria-pressed"), "true");
    await save.click();
    await form.waitFor({ state: "detached" });
    const saved = await page.evaluate(
      () =>
        fixtureRequests.findLast((r) => r.method === "lan/providers/save")
          .params,
    );
    assert.deepEqual(saved.models, models);
    assert.equal(Object.hasOwn(saved, "apiKey"), false);
    assert.equal(saved.modelAliases[model], "日常模型");
    assert.equal(saved.modelAliases[models[1]], "第二个模型");
    assert.equal(saved.modelCapabilities[models[1]].contextWindow, 32768);
    assert.equal(saved.modelCapabilities[models[2]].contextWindow, 196608);
    assert.equal(
      Object.hasOwn(saved.modelCapabilities[models[1]], "contextWindowUnit"),
      false,
    );
    assert.deepEqual(saved.modelCapabilities[model], {
      contextWindow: 262144,
      supportedEffortLevels: ["low", "max"],
      supportsFastMode: true,
      supportsAdaptiveThinking: true,
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[aria-label="模型"] option')].some(
        (option) => option.textContent.includes("日常模型"),
      ),
    );
    await edit.click();
    assert.equal(await alias.inputValue(), "日常模型");
    assert.equal(await picker.locator("option:checked").textContent(), model);
    assert.equal(await contextLength.inputValue(), "262144");
    await picker.selectOption(models[1]);
    assert.equal(await contextLength.inputValue(), "32768");
    assert.equal(await contextUnit.getAttribute("aria-pressed"), "false");
    await picker.selectOption(model);
    await alias.fill("");
    assert.equal(await picker.locator("option:checked").textContent(), model);
    await keyField.fill("replacement-fixture-key");
    await save.click();
    await form.waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(
        () =>
          fixtureRequests.findLast((r) => r.method === "lan/providers/save")
            .params.apiKey,
      ),
      "replacement-fixture-key",
    );
    await edit.click();
    await clearKey.check();
    await save.click();
    await form.waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(
        () =>
          fixtureRequests.findLast((r) => r.method === "lan/providers/save")
            .params.apiKey,
      ),
      "",
    );
    await edit.click();
    await remove.click();
    await form.waitFor({ state: "detached" });
    assert.equal(await row.count(), 0);
    await add.click();
    assert.equal(await add.getAttribute("aria-expanded"), "true");
    await page.locator(".provider-new .provider-editor").waitFor();
    assert.equal(await protocol.inputValue(), "messages");
    assert.equal(await clearKey.count(), 0);
    assert.ok(await keyField.isVisible());
    assert.equal(
      await form.getByRole("button", { name: "刷新模型" }).count(),
      0,
    );

    const settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("#zoomLevel");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.reload();
      await page.locator(".composer .ProseMirror").waitFor();
      const openSidebar = page.getByRole("button", {
        name: "显示侧栏",
        exact: true,
      });
      if (await openSidebar.isVisible()) await openSidebar.click();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await settingsPage(page, "模型服务商").click();
      await edit.click();
      await effort.getByText("xhigh", { exact: true }).click();
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        );
        for (const scale of [2, 1.5, 1.25, 1, 0.8]) {
          await zoom.selectOption(String(scale));
          await page.waitForFunction(
            (scale) => Math.abs(devicePixelRatio - scale) < 0.02,
            scale,
          );
          const connections = await form.evaluate((editor) => {
            const box = (selector) =>
              editor.querySelector(selector).getBoundingClientRect();
            const name = box('[name="name"]');
            const protocol = box('[name="protocol"]');
            const address = box('[name="baseUrl"]');
            const area = box(".provider-credentials");
            const key = box('[name="apiKey"]');
            const save = box('.provider-credentials button[type="submit"]');
            const modelIds = box('[name="models"]');
            return {
              nameProtocolInline: Math.abs(name.top - protocol.top) < 1,
              addressFullWidth:
                Math.abs(address.left - name.left) < 1 &&
                Math.abs(address.right - protocol.right) < 1,
              modelsBelow:
                address.bottom <= area.top && area.bottom <= modelIds.top,
              keyActionInline:
                Math.abs(
                  key.top + key.height / 2 - (save.top + save.height / 2),
                ) < 1,
              fullKeyWidth: Math.abs(key.width - area.width) < 1,
            };
          });
          assert.ok(
            connections.nameProtocolInline &&
              connections.addressFullWidth &&
              connections.modelsBelow &&
              (width !== 1440 || connections.keyActionInline) &&
              (width !== 390 || scale !== 2 || connections.fullKeyWidth),
            JSON.stringify({ width, theme, scale, connections }),
          );
          if (width === 390 && scale === 2 && theme === "dark") {
            await fields.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: join(output, "provider-fields-narrow.png"),
            });
          }
          const geometry = await modelList.evaluate((el) => {
            const body = el.closest(".settings-body");
            const editor = el.closest(".provider-editor");
            const picker = el.querySelector(".provider-model-picker select");
            const controls = Array.from(
              el.querySelectorAll(
                ".provider-model-fields label > span, .provider-model-fields input",
              ),
              (control) => control.getBoundingClientRect(),
            );
            const axis = el.querySelector(".provider-effort-axis");
            const unit = el
              .querySelector(".provider-context-unit")
              .getBoundingClientRect();
            const labels = Array.from(
              axis.querySelectorAll(
                ".provider-effort-option > span:last-child",
              ),
              (label) => label.getBoundingClientRect(),
            );
            return {
              dpr: devicePixelRatio,
              fits: body.scrollWidth <= body.clientWidth + 1,
              sameRow: controls.every(
                (control, index) =>
                  index === 0 ||
                  (controls[index - 1].right < control.left &&
                    Math.abs(
                      control.y +
                        control.height / 2 -
                        controls[0].y -
                        controls[0].height / 2,
                    ) < 1),
              ),
              leftAligned: [
                editor.querySelector('[name="name"]'),
                editor.querySelector('[name="baseUrl"]'),
                picker,
              ].every(
                (field) =>
                  Math.abs(
                    field.getBoundingClientRect().left - controls[1].left,
                  ) < 1,
              ),
              centeredCapacity:
                getComputedStyle(el.querySelector(".provider-model-context"))
                  .textAlign === "center",
              capacityWidth:
                controls[3].width <= 98 &&
                (el.clientWidth < 500 || controls[3].width >= 88),
              rightAligned:
                Math.abs(unit.right - picker.getBoundingClientRect().right) < 1,
              adjacentFields: controls[2].left - controls[1].right <= 10,
              unitFits:
                Math.abs(unit.left - controls[3].right) < 1 &&
                Math.abs(unit.top - controls[3].top) < 1 &&
                Math.abs(unit.bottom - controls[3].bottom) < 1 &&
                unit.right <= el.getBoundingClientRect().right + 1,
              axisFits: labels.every(
                (label, index) =>
                  index === 0 ||
                  (label.left >= labels[index - 1].right &&
                    label.y === labels[0].y),
              ),
            };
          });
          assert.ok(Math.abs(geometry.dpr - scale) < 0.02);
          assert.ok(
            geometry.fits &&
              geometry.sameRow &&
              geometry.leftAligned &&
              geometry.centeredCapacity &&
              geometry.capacityWidth &&
              geometry.rightAligned &&
              geometry.adjacentFields &&
              geometry.unitFits &&
              geometry.axisFits,
            JSON.stringify({ width, theme, scale, geometry }),
          );
          const path = join(output, `${width}-${theme}-${scale}.png`);
          if (scale === 1) await modelList.screenshot({ path });
          if (width === 1440 && theme === "light" && scale === 1) {
            await modelList.locator(".provider-model-fields").screenshot({
              path: join(output, "model-field-row.png"),
            });
          }
          if (scale === 2) {
            await modelList.scrollIntoViewIfNeeded();
            await page.screenshot({ path });
          }
        }
      }
    }
    await zoom.selectOption("1");
    await settings.close();
    console.log(
      `PASS 供应商连接配置先于模型、桌面凭据操作同行及保留、替换和清除，下拉选择十个模型与单组参数区（${height} CSS px），点选与键盘、失败重试、保存恢复、深浅主题与实际浏览器缩放`,
    );
  }
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
