import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { settingsPage } from "../helpers/settings-navigation.mjs";
import http from "node:http";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { configuredProviders } from "../../server/src/backends/provider-presets.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const main = process.env.UI_MAIN === "1";
const before = process.env.UI_BEFORE === "1";
const build = process.env.UI_BUILD_DIR || join(root, "client/dist");
const output = join(
  root,
  ".cache/provider-presets",
  before ? "before" : main ? "main" : "dual",
);
await mkdir(output, { recursive: true });
const data = {
  main,
  markdown: "模型别名测试",
  claudeItems: [],
  providerBalances: {
    deepseek: {
      currency: "CNY",
      total_balance: "1.41",
      granted_balance: "0.41",
      topped_up_balance: "1.00",
    },
  },
  providers: configuredProviders([
    {
      id: "custom",
      backendId: "claude",
      name: "自定义供应商",
      models: Array.from(
        { length: 100 },
        (_, index) => `custom-model-${index}`,
      ),
    },
  ]).map((provider) => ({
    ...provider,
    enabled: provider.preset ? false : true,
    hasApiKey: false,
  })),
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
const extension = join(profile, "zoom-extension");
await mkdir(extension);
await writeFile(
  join(extension, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Isolated browser zoom verification",
    version: "1.0",
    permissions: ["tabs"],
    background: { service_worker: "worker.js" },
  }),
);
await writeFile(
  join(extension, "worker.js"),
  "chrome.runtime.onInstalled.addListener(() => {});",
);
const context = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1440, height: 1000 },
  executablePath: process.env.CHROME_PATH,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--no-proxy-server",
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const setZoom = async (zoom) => {
    const actual = await worker.evaluate(
      async ({ url, zoom }) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.setZoom(tab.id, zoom);
        return chrome.tabs.getZoom(tab.id);
      },
      { url: page.url(), zoom },
    );
    assert.equal(actual, zoom);
    await page.waitForFunction(
      ({ zoom, width }) =>
        Math.abs(devicePixelRatio - zoom) < 0.02 &&
        Math.abs(innerWidth - width / zoom) < 2,
      { zoom, width: page.viewportSize().width },
    );
  };
  await page.locator(".composer .ProseMirror").waitFor();
  await page
    .getByRole("button", { name: /^新对话/ })
    .first()
    .click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  if (!before) await settingsPage(page, "模型服务商").click();
  const row = page.locator(".backend-heading").filter({ hasText: "DeepSeek" });
  const first = page.locator(".provider-settings .backend-heading").first();
  assert.match(await first.innerText(), /DeepSeek/);
  assert.doesNotMatch(
    await first.innerText(),
    /deepseek-flash|DeepSeek Flash|deepseek-v4-pro/,
  );
  assert.doesNotMatch(
    await page
      .locator(".backend-heading")
      .filter({ hasText: "自定义供应商" })
      .innerText(),
    /custom-model-/,
  );
  assert.equal(await first.locator("svg").count(), 0);
  const logo = first.getByRole("img", { name: "DeepSeek 标识", exact: true });
  await logo.waitFor();
  assert(
    await logo.evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  assert.equal(
    await page
      .locator(".backend-heading")
      .filter({ hasText: "自定义供应商" })
      .getByRole("img")
      .count(),
    0,
  );
  await row.getByText("待填写 API Key").waitFor();
  assert.equal(
    await page
      .locator('[aria-label="模型"] option')
      .filter({ hasText: "DeepSeek" })
      .count(),
    0,
  );
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  assert.ok(
    await row.evaluate((el) =>
      el.nextElementSibling?.matches(".provider-editor"),
    ),
  );
  const key = page.locator('input[name="apiKey"]');
  assert.equal(await key.inputValue(), "");
  assert.equal(await page.locator(".provider-settings form input").count(), 1);
  assert.equal(
    await page
      .locator(
        ".provider-settings form select, .provider-settings form textarea, .provider-models",
      )
      .count(),
    0,
  );
  await key.fill("fixture-key");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
      await setZoom(zoom);
      await key.scrollIntoViewIfNeeded();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: join(output, theme + "-" + zoom + ".png"),
      });
      const metrics = await page.evaluate(() => ({
        dpr: devicePixelRatio,
        width: innerWidth,
      }));
      assert(Math.abs(metrics.dpr - zoom) < 0.02);
      assert(Math.abs(metrics.width - 1440 / zoom) < 2);
    }
  }
  await setZoom(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await key.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "mobile.png") });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "保存供应商", exact: true }).click();
  await row.getByText("已启用", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[aria-label="模型"] option')].some((o) =>
      o.textContent.includes("DeepSeek"),
    ),
  );
  if (!before) {
    const logoSource = await logo.getAttribute("src");
    await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel("模型", { exact: true }).selectOption({
      label: "DeepSeek/DeepSeek Flash",
    });
    const footer = page.locator(".account-card");
    const brand = footer.locator(".avatar img");
    const balance = footer.getByRole("button", {
      name: /^(展开|收起)额度详情/,
    });
    const drawerOpener = page.getByRole("button", {
      name: "显示侧栏",
      exact: true,
    });
    const details = page.getByRole("region", { name: "账户额度" });
    const layouts = [];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
          await setZoom(zoom);
          const drawer = await drawerOpener.isVisible();
          if (drawer) await drawerOpener.click();
          await balance.getByText("¥1.41", { exact: true }).waitFor();
          assert.equal(await brand.getAttribute("src"), logoSource);
          assert(
            await brand.evaluate((img) => img.complete && img.naturalWidth > 0),
          );
          assert.equal(
            await balance.locator(".quota-ring .lucide-wallet").count(),
            1,
          );
          assert.equal(await balance.getByRole("progressbar").count(), 0);
          assert.equal(await balance.getAttribute("aria-expanded"), "false");
          const layout = await balance.evaluate((button) => {
            const row = button.closest(".account-row");
            const circle = button.querySelector(".quota-ring");
            const ring = circle.getBoundingClientRect();
            const icon = circle.querySelector("svg").getBoundingClientRect();
            const amount = button.querySelector(".quota-number");
            const label = amount.getBoundingClientRect();
            const centerX = (rectangle) =>
              (rectangle.left + rectangle.right) / 2;
            const centerY = (rectangle) =>
              (rectangle.top + rectangle.bottom) / 2;
            return {
              dpr: devicePixelRatio,
              viewport: innerWidth,
              fits:
                row.scrollWidth <= row.clientWidth &&
                amount.scrollWidth <= amount.clientWidth,
              ringSize: ring.width,
              walletCentered:
                getComputedStyle(circle).borderTopLeftRadius === "50%" &&
                Math.abs(ring.width - ring.height) < 1 &&
                icon.width < ring.width &&
                Math.abs(centerX(ring) - centerX(icon)) < 1 &&
                Math.abs(centerY(ring) - centerY(icon)) < 1,
              amountBelow:
                label.top >= ring.bottom &&
                Math.abs(centerX(ring) - centerX(label)) < 1,
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          layouts.push({ width, theme, zoom, ...layout });
          assert(Math.abs(layout.dpr - zoom) < 0.02, JSON.stringify(layout));
          assert(
            Math.abs(layout.viewport - width / zoom) < 2,
            JSON.stringify(layout),
          );
          assert(
            layout.fits &&
              layout.walletCentered &&
              layout.amountBelow &&
              !layout.overflow,
            JSON.stringify(layout),
          );
          const filename = `balance-${width}-${theme}-${zoom}`;
          if (zoom === 1) {
            await balance.blur();
            await page.mouse.move(0, 0);
            await footer.screenshot({ path: join(output, `${filename}.png`) });
          }
          if (width === 390 && zoom === 1) {
            await page.screenshot({
              path: join(output, `${filename}-drawer.png`),
            });
          }
          if (zoom === 1) await balance.click();
          else await balance.press("Enter");
          await details.getByText("赠金余额").waitFor();
          assert.match(
            await details.innerText(),
            /账户余额\s*¥1\.41\s*赠金余额\s*¥0\.41\s*充值余额\s*¥1\.00/,
          );
          if (zoom === 1) {
            await details.screenshot({
              path: join(output, `${filename}-expanded.png`),
            });
            if (width === 390) {
              await page.screenshot({
                path: join(output, `${filename}-drawer-expanded.png`),
              });
            }
          }
          await balance.press("Escape");
          await details.waitFor({ state: "hidden" });
          assert(
            await balance.evaluate(
              (button) => button === document.activeElement,
            ),
          );
          if (drawer) {
            await page
              .getByRole("button", { name: "收起侧栏", exact: true })
              .click();
            await balance.waitFor({ state: "hidden" });
            assert(
              await drawerOpener.evaluate(
                (button) => button === document.activeElement,
              ),
            );
          }
        }
      }
    }
    await writeFile(
      join(output, "balance-layouts.json"),
      JSON.stringify(layouts, null, 2),
    );
    await setZoom(1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settingsPage(page, "模型服务商").click();
  }
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  assert.equal(await key.inputValue(), "");
  assert.equal(await page.locator('input[name="clearKey"]').count(), 0);
  await page.getByRole("button", { name: "保存供应商", exact: true }).click();
  await row.getByText("待填写 API Key").waitFor();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[aria-label="模型"] option')].some((o) =>
        o.textContent.includes("DeepSeek"),
      ),
  );
  const saved = await page.evaluate(
    () =>
      fixtureRequests.findLast((r) => r.method === "lan/providers/save").params,
  );
  assert.equal(saved.apiKey, "");
  console.log(
    "PASS 默认供应商展示、Key 启停、模型菜单同步、DeepSeek 页脚标识和余额、深浅主题与桌面和手机缩放（隔离传输）",
  );
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
