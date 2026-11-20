import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output = join(
  root,
  ".cache/service-maintenance",
  before ? "before" : "after",
);
const build = before ? join(output, "dist") : join(root, "client/dist");
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "maintenance-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
let status = {
  current: "4.1.2",
  latest: "4.1.3",
  updateAvailable: true,
  managed: false,
  npmInstalled: true,
  task: null,
};
const actions = [];
let finish;
try {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript(backendFixture, {
    markdown: "更新服务验证",
    claudeItems: [],
  });
  await page.route("https://fixture.invalid/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/maintenance")) {
      const action = path.split("/")[3];
      if (action && action !== "check") {
        actions.push(action);
        if (finish)
          await new Promise((resolve) => {
            finish = resolve;
          });
        await route.fulfill({
          status: 409,
          json: { error: "安装目录无法写入，请检查服务账户权限。" },
        });
      } else await route.fulfill({ json: status });
      return;
    }
    const response = {
      writeHead(code, headers) {
        this.status = code;
        this.headers = headers;
        return this;
      },
      end(body) {
        this.body = body;
      },
    };
    if (serveDemoSession({ url: path }, response)) {
      await route.fulfill({
        status: response.status,
        headers: response.headers,
        body: response.body,
      });
      return;
    }
    try {
      await route.fulfill({
        body: await readFile(join(build, path === "/" ? "index.html" : path)),
        contentType:
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
          }[extname(path)] || "text/html",
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  const open = async () => {
    await page.goto("https://fixture.invalid/");
    await page.locator(".composer .ProseMirror").waitFor();
    const settings = page.getByRole("button", { name: "设置", exact: true });
    if (!(await settings.isVisible()))
      await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
    await settings.click();
    await page.getByRole("button", { name: "更新至 4.1.3" }).waitFor();
    await page.waitForFunction(
      () =>
        !document.querySelector(".service-maintenance-actions button").disabled,
    );
  };
  await open();
  const update = page.getByRole("button", { name: "更新至 4.1.3" });
  const restart = page.getByRole("button", { name: "重启服务", exact: true });
  if (before) {
    assert.equal(await update.isDisabled(), true);
    assert.equal(await restart.isDisabled(), true);
    await page.screenshot({ path: join(output, "disabled.png") });
    await page
      .locator(".service-maintenance-settings")
      .screenshot({ path: join(output, "update-card.png") });
  } else {
    for (const deployment of [
      { managed: false, npmInstalled: true },
      { managed: true, npmInstalled: false },
    ]) {
      status = { ...status, ...deployment };
      await open();
      assert.equal(await update.isEnabled(), true);
      assert.equal(await restart.isEnabled(), true);
      for (const button of [update, restart, update]) {
        await button.click();
        await page
          .getByRole("alert")
          .filter({ hasText: "安装目录无法写入" })
          .waitFor();
        assert.equal(await button.isEnabled(), true);
      }
    }
    await page.screenshot({ path: join(output, "click-error-light.png") });
    await page
      .locator(".service-maintenance-settings")
      .screenshot({ path: join(output, "update-card.png") });
    const settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("#zoomLevel");
    const layouts = [];
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 390]) {
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.setViewportSize({ width, height: 1000 });
          await open();
          await update.click();
          await page
            .getByRole("alert")
            .filter({ hasText: "安装目录无法写入" })
            .waitFor();
          const bounds = await page.locator(".settings-body").evaluate((el) => {
            const card = el.querySelector(".service-update-card");
            const alert = card.querySelector('[role="alert"]');
            const outer = card.getBoundingClientRect();
            const inner = alert?.getBoundingClientRect();
            const range = document.createRange();
            const actions = [
              ...card.querySelectorAll(".service-maintenance-actions > button"),
            ].map((button) => {
              const lines = [...button.childNodes]
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .flatMap((node) => {
                  range.selectNodeContents(node);
                  return [...range.getClientRects()].map((line) => line.top);
                });
              const rect = button.getBoundingClientRect();
              return {
                text: button.textContent,
                lineCount: new Set(lines).size,
                top: rect.top,
                insideCard:
                  rect.left >= outer.left && rect.right <= outer.right,
              };
            });
            return {
              panelWidth: el.clientWidth,
              scroll: el.scrollWidth,
              dpr: devicePixelRatio,
              viewportWidth: innerWidth,
              actions,
              feedbackInsideCard: Boolean(
                inner &&
                inner.left >= outer.left &&
                inner.right <= outer.right &&
                inner.top >= outer.top &&
                inner.bottom <= outer.bottom,
              ),
            };
          });
          assert.ok(bounds.scroll <= bounds.panelWidth + 1);
          assert.ok(Math.abs(bounds.dpr - scale) < 0.02);
          assert.ok(Math.abs(bounds.viewportWidth - width / scale) <= 1);
          assert.equal(bounds.feedbackInsideCard, true);
          assert.equal(bounds.actions.length, 3);
          for (const action of bounds.actions) {
            assert.equal(action.insideCard, true, JSON.stringify(action));
            assert.equal(action.lineCount, 1, JSON.stringify(action));
          }
          if (width === 1440)
            assert.equal(
              new Set(bounds.actions.map((action) => action.top)).size,
              1,
            );
          layouts.push({ theme, width, scale, ...bounds });
          await page.screenshot({
            path: join(output, `${theme}-${width}-${scale}.png`),
          });
        }
      }
    }
    await zoom.selectOption("1");
    await settings.close();
    finish = true;
    await update.click();
    assert.equal(await update.isDisabled(), true);
    assert.equal(await restart.isDisabled(), true);
    finish();
    await page.waitForFunction(
      () => !document.querySelector(".service-update-button").disabled,
    );
    finish = null;
    status = { ...status, updateAvailable: false, latest: "4.1.2" };
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    assert.equal(
      await page.getByRole("button", { name: "无需更新" }).isDisabled(),
      true,
    );
    assert.equal(await restart.isEnabled(), true);
    await writeFile(
      join(output, "verification.json"),
      JSON.stringify(
        {
          actions,
          status,
          layouts,
          build: JSON.parse(
            await readFile(join(root, "build-info.json"), "utf8"),
          ),
        },
        null,
        2,
      ),
    );
  }
  console.log(
    `PASS maintenance browser ${before ? "disabled reproduction" : "click, errors, retry, pending, current, themes and narrow screen"}`,
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
