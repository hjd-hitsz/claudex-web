import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output =
  process.env.BROWSER_OUTPUT_DIR ||
  join(root, ".cache/cli-installation", before ? "before" : "after");
const build =
  process.env.BROWSER_BUILD_DIR ||
  (before
    ? join(root, ".cache/cli-installation-before/dist")
    : join(root, "client/dist"));
await mkdir(output, { recursive: true });
const detail =
  "Error: Missing optional dependency @vendor/cli-linux-x64\n" +
  "    at findExecutable (file:///demo/node/lib/node_modules/@vendor/cli/bin/native.js:20:10)\n".repeat(
    10,
  );
const installations = Object.fromEntries(
  ["codex", "claude"].map((id) => [
    id,
    {
      installed: false,
      checking: false,
      currentVersion: "",
      latestVersion: id === "codex" ? "0.167.2" : "2.1.318",
      error: before
        ? "Command failed: /demo/node/lib/node_modules/@vendor/cli/bin/native --version\n" +
          detail
        : `${id === "codex" ? "Codex" : "Claude Code"} CLI 无法运行，可点击一键安装修复。`,
      ...(before ? {} : { errorDetails: detail }),
    },
  ]),
);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "cli-installation-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
const layouts = [];
try {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript(backendFixture, {
    markdown: "检查 CLI 安装",
    claudeItems: [],
    backendInstallations: installations,
  });
  await page.route("https://fixture.invalid/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = {
      writeHead(status, headers) {
        this.status = status;
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto("https://fixture.invalid/");
    await page.locator(".composer .ProseMirror").waitFor();
    const settings = page.getByRole("button", { name: "设置", exact: true });
    if (!(await settings.isVisible()))
      await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
    await settings.click();
    await page.locator(".backend-card").first().waitFor();
  };
  await open();
  if (before) {
    for (const width of [1440, 420]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: join(output, `light-${width}.png`) });
    }
  } else {
    const card = page.locator(".backend-card").first();
    await card.getByText("错误详情", { exact: true }).click();
    assert.match(await card.locator("pre").textContent(), /findExecutable/);
    await page.screenshot({ path: join(output, "desktop-details.png") });
    await page.setViewportSize({ width: 420, height: 1000 });
    await page.screenshot({ path: join(output, "mobile-details.png") });
    await card.getByText("错误详情", { exact: true }).click();
    const claude = page
      .locator(".backend-card")
      .filter({ has: page.locator("strong", { hasText: /^Claude Code$/ }) });
    await claude.getByRole("button", { name: "一键安装", exact: true }).click();
    await claude.locator(".backend-version").waitFor();
    assert.equal(await claude.locator(".cli-error-details").count(), 0);
    await page.evaluate(() =>
      window.backendSocket.setBackendInstallation("claude", {
        installed: false,
        currentVersion: "",
        installError:
          "Claude Code 原生组件下载失败，请检查服务器网络或代理后重试。",
        installErrorDetails: "npm error code ECONNRESET",
      }),
    );
    await claude.getByRole("button", { name: "一键安装", exact: true }).click();
    await claude.locator(".backend-version").waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          window.fixtureRequests.filter(
            (r) => r.method === "lan/backends/install",
          ).length,
      ),
      2,
    );
    await page.evaluate(() => {
      for (const [id, version] of [
        ["codex", "0.167.2"],
        ["claude", "2.1.322"],
      ]) {
        window.backendSocket.setBackendInstallation(id, {
          installed: true,
          currentVersion: version,
          latestVersion: version,
          error: "",
          errorDetails: "",
          installError: "",
          installErrorDetails: "",
        });
      }
    });
    await claude
      .getByRole("checkbox", { name: "启用 Claude Code", exact: true })
      .uncheck();
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".backend-heading input")].every(
        (input) => !input.disabled,
      ),
    );
    await page.screenshot({ path: join(output, "installed-mobile.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(output, "installed-desktop.png") });
    const settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const zoom = settings.locator("#zoomLevel");
    await zoom.waitFor();
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 420]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.emulateMedia({ colorScheme: theme });
          await open();
          await page
            .locator(".backend-card")
            .first()
            .getByText("错误详情", { exact: true })
            .click();
          const metrics = await page
            .locator(".settings-body")
            .evaluate((element) => ({
              dpr: devicePixelRatio,
              width: innerWidth,
              scroll: element.scrollWidth,
              client: element.clientWidth,
            }));
          assert.ok(Math.abs(metrics.dpr - scale) < 0.02);
          assert.ok(Math.abs(metrics.width - width / scale) <= 1);
          assert.ok(
            metrics.scroll <= metrics.client + 1,
            JSON.stringify({ theme, width, scale, metrics }),
          );
          layouts.push({ theme, width, scale, metrics });
          await page.screenshot({
            path: join(output, `${theme}-${width}-${scale}.png`),
          });
        }
      }
    }
    await zoom.selectOption("1");
    assert.equal(await zoom.inputValue(), "1");
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        before,
        layouts,
        build: JSON.parse(
          await readFile(
            process.env.BROWSER_BUILD_INFO ||
              (before
                ? join(root, ".cache/cli-installation-before/build-info.json")
                : join(root, "build-info.json")),
            "utf8",
          ),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
