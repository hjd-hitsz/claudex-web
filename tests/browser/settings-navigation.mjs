import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { configuredProviders } from "../../server/src/backends/provider-presets.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import {
  settingsBackend,
  settingsPage,
  openSettingsPage,
} from "../helpers/settings-navigation.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = join(root, ".cache/settings-navigation");
const profile = await mkdtemp(join(tmpdir(), "claudex-settings-navigation-"));
const build = join(profile, "dist");
await cp(process.env.UI_BUILD_DIR || join(root, "client/dist"), build, {
  recursive: true,
});
const staticHandler = createStaticHandler(build);
const titles = ["通用", "后端", "模型服务商", "连接与登录", "更新与重启"];
const viewport = { width: 1440, height: 960 };
const latest = "4.2.1";
let p2pReads = 0;
const server = http.createServer((request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  const json = (value) =>
    response
      .writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(JSON.stringify(value));
  if (path.startsWith("/api/maintenance"))
    return json({
      current: "4.2.0",
      latest,
      checkedAt: new Date().toISOString(),
      npmInstalled: true,
      updateAvailable: true,
      task: null,
    });
  if (serveDemoSession(request, response, { totpStatus: "enabled" })) return;
  if (path === "/api/p2p") {
    p2pReads += 1;
    return json({ enabled: false, state: "disabled", links: [] });
  }
  return staticHandler(request, response, path);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const context = await chromium.launchPersistentContext(
  join(profile, "browser"),
  {
    executablePath: process.env.CHROME_PATH,
    viewport,
    headless: true,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
  },
);

try {
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(artifacts, "build-info.json"),
    await readFile(join(root, "build-info.json")),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript(backendFixture, {
    main: true,
    markdown: "请梳理 Atlas 示例项目的快速开始步骤。",
    claudeItems: [],
    backendInstallations: {
      codex: {
        installed: true,
        currentVersion: "0.169.0",
        latestVersion: "0.169.0",
      },
      claude: {
        installed: true,
        currentVersion: "2.1.318",
        latestVersion: "2.1.318",
      },
    },
    providers: configuredProviders([
      {
        id: "fixture-provider",
        backendId: "claude",
        name: "示例供应商",
        baseUrl: "https://provider.example.invalid",
        models: ["fixture-model"],
      },
    ]).map(({ apiKey, ...row }) => ({ ...row, hasApiKey: Boolean(apiKey) })),
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page
    .locator(".composer .ProseMirror")
    .waitFor()
    .catch(async (error) => {
      console.error("页面启动状态", await page.locator("body").innerText());
      throw error;
    });
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const heading = dialog.locator(".settings-page-heading h2");
  const nav = dialog.getByRole("navigation", { name: "设置分类" });
  const close = dialog.getByRole("button", { name: "关闭窗口", exact: true });
  const open = page.getByRole("button", { name: "设置", exact: true });
  const showSidebar = page.getByRole("button", {
    name: "显示侧栏",
    exact: true,
  });
  const hideSidebar = page.getByRole("button", {
    name: "收起侧栏",
    exact: true,
  });
  const pick = (title) => settingsPage(page, title);
  const focus = (locator) =>
    locator.evaluate((element) => element === document.activeElement);
  const screenshot = (name) =>
    page.screenshot({
      path: join(artifacts, name + ".png"),
      animations: "disabled",
    });
  function providerReads() {
    return page.evaluate(
      () =>
        window.fixtureRequests.filter(
          ({ method, params }) =>
            method === "lan/providers/list" && params.includeDisabled,
        ).length,
    );
  }

  const collapsedProjects = page.locator(
    '.project-heading > button[aria-expanded="false"]',
  );
  while (await collapsedProjects.count())
    await collapsedProjects.first().click();
  const ink = {};
  for (const backend of ["codex", "claude"]) {
    ink[backend] = await readBadgeInk(
      page,
      page
        .locator(`.thread-link [data-backend="${backend}"] .backend-symbol`)
        .first(),
    );
  }
  for (const axis of ["width", "height"])
    assert(
      Math.abs(ink.codex[axis] - ink.claude[axis]) <= 1,
      JSON.stringify(ink),
    );
  await page.locator(".sidebar").screenshot({
    path: join(artifacts, "sidebar-backend-symbols.png"),
    animations: "disabled",
  });

  await open.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  assert.equal(await heading.textContent(), "通用");
  assert.deepEqual(await nav.getByRole("button").allTextContents(), titles);
  assert(await focus(pick("通用")));
  assert.equal(await providerReads(), 0);
  assert.equal(p2pReads, 0);
  await screenshot("desktop-light-general");
  await page.keyboard.press("Tab");
  assert(await focus(pick("后端")));
  await page.keyboard.press("Enter");
  assert.equal(await heading.textContent(), "后端");
  await settingsBackend(page, "Claude Code").click();
  await dialog.getByRole("checkbox", { name: "启用 Claude Code" }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "添加供应商" }).count(),
    0,
  );
  await screenshot("desktop-light-backends");

  await pick("模型服务商").click();
  const row = dialog
    .locator(".provider-entry")
    .filter({ hasText: "示例供应商" });
  await row.waitFor();
  assert.equal(await providerReads(), 1);
  assert.equal(
    await dialog.getByRole("checkbox", { name: "启用 Claude Code" }).count(),
    0,
  );
  const addProvider = dialog.getByRole("button", {
    name: "添加供应商",
    exact: true,
  });
  assert(
    await addProvider.evaluate((element) =>
      Boolean(element.closest(".settings-page-heading")),
    ),
  );
  await screenshot("desktop-light-providers");
  await addProvider.click();
  const editor = dialog.locator(".provider-editor");
  await editor.waitFor();
  const name = editor.getByRole("textbox", { name: "名称", exact: true });
  assert(await focus(name));
  await name.fill("未保存的独立供应商");
  await pick("后端").click();
  await editor.waitFor({ state: "hidden" });
  assert.equal(await addProvider.count(), 0);
  assert(
    await editor.locator('input[name="name"]').evaluate((element) => {
      element.focus();
      return element !== document.activeElement;
    }),
  );
  await pick("模型服务商").click();
  assert.equal(await name.inputValue(), "未保存的独立供应商");
  assert.equal(await providerReads(), 1);
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const alias = editor.getByRole("textbox", { name: "显示别名" });
  await alias.fill("设置回归模型");
  await page.evaluate(() => {
    const socket = window.backendSocket;
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      if (JSON.parse(raw).method !== "lan/providers/save") return send(raw);
      window.releaseProviderSave = () => send(raw);
      socket.send = send;
    };
  });
  await editor.getByRole("button", { name: "保存供应商", exact: true }).click();
  await page.waitForFunction(() => Boolean(window.releaseProviderSave));
  await pick("后端").click();
  await page.evaluate(() => window.releaseProviderSave());
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".backend-card select option")].some(
      (option) => option.textContent.includes("设置回归模型"),
    ),
  );
  await pick("模型服务商").click();
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  assert.equal(await alias.inputValue(), "设置回归模型");
  await editor.getByRole("button", { name: "取消", exact: true }).click();

  await pick("连接与登录").click();
  await dialog.getByText("已关闭", { exact: true }).waitFor();
  await screenshot("desktop-light-connection");
  await pick("通用").click();
  const readsWhileHidden = p2pReads;
  await page.waitForTimeout(4300);
  assert.equal(p2pReads, readsWhileHidden, "隐藏连接页面时停止 P2P 轮询");
  await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/p2p",
    ),
    pick("连接与登录").click(),
  ]);
  assert(p2pReads > readsWhileHidden);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(await focus(open));

  const update = page
    .getByRole("button", { name: `发现新版本 ${latest}` })
    .first();
  await update.click();
  await dialog.getByRole("button", { name: `更新至 ${latest}` }).waitFor();
  assert.equal(await heading.textContent(), "更新与重启");
  assert(await focus(heading));
  await screenshot("desktop-light-maintenance");
  await close.click();
  await dialog.waitFor({ state: "hidden" });
  assert(await focus(update));

  const chromeSettings = await context.newPage();
  await chromeSettings.goto("chrome://settings/appearance");
  const zoom = chromeSettings.locator("#zoomLevel");
  await zoom.waitFor();
  const results = [];
  try {
    for (const dimensions of [viewport, { width: 390, height: 844 }]) {
      await page.setViewportSize(dimensions);
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.reload();
          await page.locator(".composer .ProseMirror").waitFor();
          const openedSidebar = !(await open.isVisible());
          if (openedSidebar) await showSidebar.click();
          await open.click();
          assert.equal(await heading.textContent(), "通用");
          for (const title of scale === 1 ? titles : ["后端"]) {
            await openSettingsPage(page, title);
            assert.equal(await heading.textContent(), title);
            if (await nav.isVisible())
              assert.equal(
                await pick(title).getAttribute("aria-current"),
                "page",
              );
          }
          await openSettingsPage(page, "后端");
          const metrics = await measureLayout(dialog);
          const result = { ...dimensions, theme, scale, ...metrics };
          results.push(result);
          await screenshot(`${dimensions.width}-${theme}-${scale}-backends`);
          const diagnostic = JSON.stringify(result);
          assert(Math.abs(metrics.dpr - scale) < 0.02, diagnostic);
          assert(
            Math.abs(metrics.innerWidth - dimensions.width / scale) <= 1,
            diagnostic,
          );
          assert(
            Math.abs(metrics.innerHeight - dimensions.height / scale) <= 1,
            diagnostic,
          );
          assert.equal(metrics.theme, theme);
          assert.equal(metrics.railColor, metrics.sidebarColor, diagnostic);
          if (metrics.activeThread && metrics.activeTab) {
            assert.deepEqual(
              metrics.activeThread,
              metrics.activeTab,
              diagnostic,
            );
          }
          assert(metrics.bodyHeight > 40, diagnostic);
          assert(metrics.bodyScrollWidth <= metrics.bodyWidth + 1, diagnostic);
          for (const [first, ...rest] of metrics.navigationColumns)
            for (const entry of rest) {
              assert(Math.abs(entry.icon - first.icon) <= 1, diagnostic);
              assert(Math.abs(entry.label - first.label) <= 1, diagnostic);
            }
          for (const control of metrics.controls)
            assert(
              control.x >= 0 &&
                control.y >= 0 &&
                control.right <= metrics.innerWidth + 1 &&
                control.bottom <= metrics.innerHeight + 1 &&
                control.visible,
              diagnostic,
            );
          if (dimensions.width === 390 && scale === 1) {
            assert.deepEqual(metrics.navigationRowSizes, [2, 2, 1], diagnostic);
            await page.setViewportSize({ ...dimensions, height: 560 });
            await pick("模型服务商").click();
            await row
              .getByRole("button", { name: "编辑", exact: true })
              .click();
            const body = dialog.locator(".settings-body");
            const scrolled = await body.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
              return element.scrollTop;
            });
            assert(scrolled > 0);
            await pick("后端").click();
            await pick("模型服务商").click();
            assert.equal(await body.evaluate((el) => el.scrollTop), scrolled);
            await page.setViewportSize(dimensions);
            await body.evaluate((el) => (el.scrollTop = 0));
            await screenshot(`mobile-${theme}-provider-editor`);
            await pick("连接与登录").click();
            await dialog.getByText("已关闭", { exact: true }).waitFor();
            await screenshot(`mobile-${theme}-connection`);
          }
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          assert(await focus(open));
          if (openedSidebar) {
            await hideSidebar.click();
            await page.locator(".sidebar").waitFor({ state: "hidden" });
            assert(await focus(showSidebar));
          }
        }
      }
    }
  } finally {
    await zoom.selectOption("1");
    await chromeSettings.close();
  }
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify({ browserPageZoom: true, results, ink }, null, 2) + "\n",
  );
  console.log(
    `PASS settings navigation, ${results.length} zoom cases, sidebar badge ink ${JSON.stringify(ink)}`,
  );
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}

async function readBadgeInk(page, glyph) {
  await glyph.waitFor();
  const bounds = await glyph.boundingBox();
  const image = await glyph.screenshot({ animations: "disabled" });
  return page.evaluate(
    async ({ png, bounds }) => {
      const bytes = Uint8Array.from(atob(png), (character) =>
        character.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let left = bitmap.width;
      let right = -1;
      let top = bitmap.height;
      let bottom = -1;
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
          const index = (y * bitmap.width + x) * 4;
          if (
            Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) >= 160
          )
            continue;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      if (right < left || bottom < top) throw new Error("后端标识未绘制");
      return {
        width: ((right - left + 1) * bounds.width) / bitmap.width,
        height: ((bottom - top + 1) * bounds.height) / bitmap.height,
      };
    },
    { png: image.toString("base64"), bounds },
  );
}

function measureLayout(dialog) {
  return dialog.evaluate((element) => {
    const body = element.querySelector(".settings-body");
    const buttons = [
      ...element.querySelectorAll(".settings-navigation button"),
    ].filter((control) => control.getClientRects().length);
    const compact = element.querySelector(".settings-compact-navigation");
    const rows = new Map();
    const columns = new Map();
    for (const button of buttons) {
      const { x, y } = button.getBoundingClientRect();
      const row = Math.round(y);
      const column = Math.round(x);
      rows.set(row, 1 + (rows.get(row) ?? 0));
      if (!columns.has(column)) columns.set(column, []);
      columns.get(column).push({
        icon: button.querySelector("svg").getBoundingClientRect().left,
        label: button.querySelector("span").getBoundingClientRect().left,
      });
    }
    function selectionStyle(control) {
      return (
        control && {
          background: getComputedStyle(control).backgroundColor,
          marker: getComputedStyle(control, "::before").backgroundColor,
        }
      );
    }
    return {
      dpr: devicePixelRatio,
      innerWidth,
      innerHeight,
      theme: getComputedStyle(document.documentElement).colorScheme,
      bodyHeight: body.clientHeight,
      bodyWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      navigationRowSizes: [...rows.values()],
      navigationColumns: [...columns.values()],
      railColor: getComputedStyle(element.querySelector(".settings-rail"))
        .backgroundColor,
      sidebarColor: getComputedStyle(document.querySelector(".sidebar"))
        .backgroundColor,
      activeTab: selectionStyle(
        buttons.find(
          (button) => button.getAttribute("aria-current") === "page",
        ),
      ),
      activeThread: selectionStyle(
        document.querySelector(".thread-row.selected"),
      ),
      controls: [
        ...(buttons.length ? buttons : [compact]),
        element.querySelector(".settings-close"),
      ].map((control) => {
        const { x, y, width, height, right, bottom } =
          control.getBoundingClientRect();
        return {
          name: control.textContent || control.title,
          x,
          y,
          right,
          bottom,
          visible: control.contains(
            document.elementFromPoint(x + width / 2, y + height / 2),
          ),
        };
      }),
    };
  });
}
