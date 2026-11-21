import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, ".cache/p2p-settings-browser");
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "build-info.json"),
  await readFile(join(root, "build-info.json")),
);

const linkOrigin = "https://claudex-p2p.example.invalid";
const serveStatic = createStaticHandler(
  process.env.UI_BUILD_DIR || join(root, "client/dist"),
);
const links = [];
const mutations = [];
let enabled = false;
let connecting = false;
let createFailed = false;
let expireReads = false;
let reads = 0;
let serial = 0;
const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response, { totpStatus: "enabled" })) return;
  const { pathname } = new URL(request.url, "http://fixture");
  if (!pathname.startsWith("/api/p2p"))
    return serveStatic(request, response, pathname);
  const result = (body, status = 200) =>
    response
      .writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(JSON.stringify(body));
  let created;
  if (request.method === "GET") {
    reads += 1;
    if (expireReads) return result({ error: "设置暂时无法读取" }, 503);
  } else {
    const action = pathname.split("/").at(-1);
    const body = await json(request);
    mutations.push({ action, body });
    if (action === "enable") {
      enabled = true;
      connecting = true;
      setTimeout(() => (connecting = false), 100);
    } else if (action === "disable") {
      enabled = false;
    } else if (action === "create") {
      if (!createFailed) {
        createFailed = true;
        return result({ error: "暂时无法生成链接" }, 503);
      }
      serial += 1;
      created = {
        id: `link-${serial}`,
        label: body.label || "远程访问",
        createdAt: Date.now(),
        url: `${linkOrigin}/p2p#fixture-link-${serial}`,
      };
      links.unshift(created);
    } else if (action === "revoke") {
      links.splice(
        links.findIndex((link) => link.id === body.id),
        1,
      );
    }
  }
  return result({
    enabled,
    state: enabled ? (connecting ? "connecting" : "online") : "disabled",
    origin: linkOrigin,
    error: null,
    links,
    created,
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "p2p-settings-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  viewport: { width: 1280, height: 960 },
  headless: true,
  args: ["--no-sandbox", "--no-proxy-server"],
});
try {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const page = await context.newPage();
  await page.addInitScript(backendFixture, {
    markdown: "P2P 浏览器设置验证",
    claudeItems: [],
  });
  await page.goto(origin);
  await page.locator(".composer .ProseMirror").waitFor();
  assert.equal(reads, 0);

  const settingsButton = page.getByRole("button", {
    name: "设置",
    exact: true,
  });
  const collapseSidebar = page.getByRole("button", { name: "收起侧栏" });
  const closeDialog = page.getByRole("button", { name: "关闭窗口" });
  const section = page.getByRole("region", { name: "连接与登录" });
  const account = section.getByRole("region", { name: "账号与双重验证" });
  const certificate = section.getByRole("region", {
    name: "局域网 HTTPS 证书",
  });
  const remote = section.getByRole("region", { name: "P2P 远程访问" });
  const totpHelp = account.getByText("双重验证使用方法", { exact: true });
  const toggle = section.getByRole("checkbox", { name: "P2P 远程访问" });
  const name = section.getByRole("textbox", { name: "设备名称" });
  const create = section.getByRole("button", { name: "生成链接" });
  const link = (label) =>
    section.getByRole("listitem").filter({ hasText: label });

  async function openSettings() {
    if (!(await settingsButton.isVisible())) {
      await page.getByRole("button", { name: "显示侧栏" }).click();
    }
    await settingsButton.click();
    await section.scrollIntoViewIfNeeded();
  }

  await openSettings();
  const certificateHelp = certificate.getByText("浏览器证书安装", {
    exact: true,
  });
  await certificateHelp.waitFor();
  assert.equal(await account.locator(".certificate-help").count(), 0);
  assert.equal(
    await remote.getByRole("button", { name: "退出登录" }).count(),
    0,
  );
  assert.equal(await certificate.locator("details").getAttribute("open"), null);
  await section.getByText("已关闭", { exact: true }).waitFor();
  await section.getByText("双重验证（2FA）已启用", { exact: true }).waitFor();
  assert.equal(
    await section.locator(".totp-settings details").getAttribute("open"),
    null,
  );
  await totpHelp.click();
  assert.equal(await certificate.locator("details").getAttribute("open"), null);
  await section.getByRole("button", { name: "复制绑定命令" }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "claudex-web auth setup 我的手机",
  );
  await section.getByRole("button", { name: "复制列表命令" }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "claudex-web auth list",
  );
  await section.getByRole("button", { name: "复制关闭命令" }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "claudex-web auth disable",
  );
  await totpHelp.click();
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await create.count(), 0);
  assert.equal(await section.locator(".p2p-settings > p").count(), 0);
  assert.equal(
    await section.getByRole("button", { name: "退出登录" }).count(),
    1,
  );
  await page.screenshot({ path: join(output, "1280-disabled-light.png") });
  await toggle.click();
  await section.getByText("正在连接入口…", { exact: true }).waitFor();
  await section.getByText("入口在线", { exact: true }).waitFor();
  assert.equal(await section.locator(".p2p-settings > p").count(), 0);

  await name.fill("我的手机");
  await name.press("Enter");
  await section.getByRole("alert").getByText("暂时无法生成链接").waitFor();
  assert.equal(await name.inputValue(), "我的手机");
  await create.click();
  await link("我的手机").waitFor();
  await name.fill("备用平板");
  await create.click();
  await link("备用平板").waitFor();
  await section.screenshot({
    path: join(output, "connection-cards-light.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 960 });
  await page.emulateMedia({ colorScheme: "dark" });
  await section.screenshot({
    path: join(output, "connection-cards-mobile-dark.png"),
    animations: "disabled",
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 960 });

  await link("我的手机").getByRole("button", { name: "复制链接" }).click();
  await link("我的手机").getByRole("button", { name: "已复制" }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    links.find((entry) => entry.label === "我的手机").url,
  );
  await link("我的手机").getByRole("button", { name: "撤销 我的手机" }).click();
  await link("我的手机")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(
    mutations.some(({ action }) => action === "revoke"),
    false,
  );
  await link("我的手机").getByRole("button", { name: "撤销 我的手机" }).click();
  await link("我的手机")
    .getByRole("button", { name: "确认撤销 我的手机" })
    .click();
  await link("我的手机").waitFor({ state: "detached" });
  assert.deepEqual(mutations.at(-1), {
    action: "revoke",
    body: { id: "link-1" },
  });
  await link("备用平板").waitFor();

  await toggle.click();
  await section.getByText("已关闭", { exact: true }).waitFor();
  await link("备用平板").waitFor();
  await closeDialog.click();
  const readsAtClose = reads;
  await page.reload();
  await page.locator(".composer .ProseMirror").waitFor();
  assert.equal(reads, readsAtClose);
  expireReads = true;
  await openSettings();
  await section.getByRole("alert").getByText("设置暂时无法读取").waitFor();
  assert.equal(await toggle.isDisabled(), true);
  expireReads = false;
  await section.getByRole("button", { name: "重试", exact: true }).click();
  await link("备用平板").waitFor();
  await toggle.click();
  await section.getByText("入口在线", { exact: true }).waitFor();
  await closeDialog.click();

  const zoomTab = await context.newPage();
  await zoomTab.goto("chrome://settings/appearance");
  const zoom = zoomTab.locator("#zoomLevel");
  await zoom.waitFor();
  const layout = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const theme of ["light", "dark"]) {
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.reload();
        await page.locator(".composer .ProseMirror").waitFor();
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.bringToFront();
        await openSettings();
        await link("备用平板").waitFor();
        await totpHelp.click();
        await section.getByRole("button", { name: "复制关闭命令" }).waitFor();
        const measurements = await section.evaluate((card) => ({
          dpr: devicePixelRatio,
          innerWidth,
          helpTypography: [
            ...card.querySelectorAll(
              ".totp-help > summary, .certificate-help > summary",
            ),
          ].map((summary) => {
            const { fontFamily, fontSize, fontWeight, lineHeight, color } =
              getComputedStyle(summary);
            return { fontFamily, fontSize, fontWeight, lineHeight, color };
          }),
          targets: [...card.querySelectorAll("button, input")]
            .filter((element) => element.offsetWidth > 0)
            .map((element) => {
              const { left, right, height, width } =
                element.getBoundingClientRect();
              return { left, right, height, width };
            }),
        }));
        const result = { width, theme, scale, ...measurements };
        layout.push(result);
        assert.ok(Math.abs(result.dpr - scale) < 0.02, JSON.stringify(result));
        assert.ok(Math.abs(result.innerWidth - width / scale) <= 1);
        assert.equal(result.helpTypography.length, 2);
        assert.deepEqual(result.helpTypography[0], result.helpTypography[1]);
        for (const target of result.targets) {
          assert.ok(target.left >= 0 && target.right <= result.innerWidth + 1);
          assert.ok(target.height >= 15 && target.width >= 15);
        }
        if (scale === 1)
          await page.screenshot({
            path: join(output, `${width}-${theme}.png`),
          });
        await page.keyboard.press("Escape");
        await section.waitFor({ state: "detached" });
        if (await page.locator(".sidebar.mobile-open").count()) {
          await collapseSidebar.click();
          const sidebar = page.locator(".sidebar");
          await sidebar.waitFor({ state: "hidden" });
          assert.equal(
            await sidebar.evaluate((element) =>
              element.contains(document.activeElement),
            ),
            false,
          );
        }
      }
    }
  }
  await zoom.selectOption("1");
  await zoomTab.close();
  await writeFile(join(output, "layout.json"), JSON.stringify(layout, null, 2));
  console.log("PASS P2P 设置、复制、撤销、启停与浏览器布局");
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
