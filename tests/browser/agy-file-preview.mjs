import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWebApplication } from "../../server/src/application.mjs";
import { createAuthentication } from "../../server/src/auth.mjs";
import { createBackendConfiguration } from "../../server/src/backends/configuration.mjs";
import {
  connectIpc,
  workerLocation,
} from "../../server/src/backends/agy/worker-ipc.mjs";
import { readConfig } from "../../server/src/config.mjs";
import { authenticationFixture } from "../helpers/auth.mjs";

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output = resolve(
  process.env.AGY_PREVIEW_OUTPUT_DIR || ".cache/agy-background-preview",
);
const before = process.env.BROWSER_BEFORE === "1";
const root = await mkdtemp(join(tmpdir(), "claudex-agy-preview-"));
const cwd = join(root, "preview-demo");
const bin = join(root, "bin");
await Promise.all(
  [cwd, bin, output].map((dir) => mkdir(dir, { recursive: true })),
);
const fixture = fileURLToPath(
  new URL("../helpers/agy-fixture-cli.mjs", import.meta.url),
);
await writeFile(
  join(bin, "agy"),
  `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
  { mode: 0o700 },
);
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
await writeFile(
  join(cwd, "核对 #1.md"),
  "# Antigravity 文件预览\n\n来自隔离工作区的 Markdown 正文。\n",
);
const oldPath = process.env.PATH;
const previousRuntime = process.env.XDG_RUNTIME_DIR;
process.env.PATH = bin + ":" + oldPath;
process.env.XDG_RUNTIME_DIR = root;
const config = {
  ...readConfig({
    ...process.env,
    CLAUDEX_WEB_CONFIG_DIR: root,
    CLAUDEX_WEB_BACKENDS_FILE: join(root, "backends.json"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    DEFAULT_CWD: cwd,
    HOST: "127.0.0.1",
    PORT: "0",
  }),
  ...(before && { staticDir: join(output, "before-build") }),
};
const settings = createBackendConfiguration(config);
await settings.save({ id: "codex", type: "codex", enabled: false });
await settings.save({ id: "claude", type: "claude", enabled: false });
const backend = await settings.save({ id: "agy", type: "agy", enabled: true });
const auth = await authenticationFixture(root);
const app = createWebApplication({
  config,
  tls: auth.tls,
  authentication: await createAuthentication(config),
  version: { version: "4.2.2", displayVersion: "4.2.2" },
});
let context;
try {
  await app.start();
  const url = "https://127.0.0.1:" + app.server.address().port;
  context = await chromium.launchPersistentContext(join(root, "browser"), {
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 920 },
  });
  await context.addCookies([
    {
      name: "__Host-claudex-web-session",
      value: auth.cookie.split("=")[1],
      url,
      httpOnly: true,
    },
  ]);
  const page = await context.newPage();
  const outgoing = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string") outgoing.push(JSON.parse(payload));
    }),
  );
  page.setDefaultTimeout(10_000);
  await page.goto(url);
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  const tools = page.getByRole("navigation", { name: "工作区快捷工具" });
  async function openFile() {
    await tools.getByRole("button", { name: "文件", exact: true }).click();
    const file = page.getByRole("button", { name: "核对 #1.md", exact: true });
    const list = page.getByRole("button", { name: "文件列表", exact: true });
    await file.or(list).first().waitFor();
    if (await list.isVisible()) await list.click();
    await file.click();
  }
  if (before) {
    await openFile();
    await page.getByText("agy 对话不存在", { exact: true }).waitFor();
    await page.screenshot({ path: join(output, "preview-before.png") });
  } else {
    const preview = page.getByRole("heading", { name: "Antigravity 文件预览" });
    await openFile();
    await preview.waitFor();
    await page.screenshot({ path: join(output, "preview-new-light.png") });
    await tools.getByRole("button", { name: "折叠对话详情" }).click();
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("浏览器验收对话");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("秘书已核对内容", { exact: true }).waitFor();
    await page.waitForFunction(() =>
      localStorage.getItem("cx-current")?.startsWith("backend:agy:"),
    );
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await openFile();
    await preview.waitFor();
    await page.screenshot({ path: join(output, "preview-existing-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await tools.getByRole("button", { name: "折叠对话详情" }).click();
    await openFile();
    await preview.waitFor();
    await page.screenshot({ path: join(output, "preview-mobile-dark.png") });
    await tools.getByRole("button", { name: "折叠对话详情" }).click();
    assert.equal(await preview.isVisible(), false);
    await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#project-sidebar")
          .contains(document.activeElement),
    );
    const preferences = await context.newPage();
    await preferences.goto("chrome://settings/appearance");
    const zoom = preferences.locator("#zoomLevel");
    for (const width of [1400, 390]) {
      await page.setViewportSize({ width, height: 920 });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.reload();
          await openFile();
          await preview.waitFor();
          const metrics = await preview.evaluate((element) => ({
            dpr: devicePixelRatio,
            viewport: innerWidth,
            scroll: document.documentElement.scrollWidth,
            left: element.getBoundingClientRect().left,
          }));
          assert.ok(
            Math.abs(metrics.dpr - scale) < 0.02,
            JSON.stringify(metrics),
          );
          assert.ok(
            Math.abs(metrics.viewport - width / scale) <= 1,
            JSON.stringify(metrics),
          );
          assert.ok(
            metrics.scroll <= metrics.viewport + 1 && metrics.left >= 0,
            JSON.stringify(metrics),
          );
          await tools.getByRole("button", { name: "折叠对话详情" }).click();
        }
      }
    }
    await zoom.selectOption("1");
    await preferences.close();
    await page.setViewportSize({ width: 1400, height: 920 });
    const message = page.getByRole("textbox", { name: "消息", exact: true });
    const send = page.getByRole("button", { name: "发送消息", exact: true });
    await message.fill("AGY_BROWSER_INTERRUPT 旧要求");
    await send.click();
    await page.getByRole("button", { name: "停止任务", exact: true }).waitFor();
    await message.fill("AGY_BROWSER_REPLACE 新的要求");
    await send.click();
    await page.getByText("秘书已处理新的要求", { exact: true }).waitFor();
    assert(
      outgoing.some(
        ({ method, params }) =>
          method === "turn/steer" &&
          params.expectedTurnId &&
          params.input[0].text.includes("AGY_BROWSER_REPLACE"),
      ),
    );
    await page.screenshot({ path: join(output, "browser-interrupt.png") });
    await page
      .getByText("任务已停止", { exact: true })
      .waitFor({ state: "hidden" });
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await message.fill("AGY_BROWSER_TOOL_ERROR 核对缺失的演示文件");
    await send.click();
    const finalReply = page.getByText("文件不存在，已根据工具结果完成核对。", {
      exact: true,
    });
    await finalReply.waitFor();
    const tool = page
      .getByText("ls fixture-missing.txt", { exact: false })
      .last();
    const processDisclosure = page
      .locator("summary")
      .filter({ hasText: "工作过程" })
      .last();
    if (!(await tool.isVisible())) await processDisclosure.click();
    await tool.click();
    await page.getByText("命令退出码 2", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "停止任务", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await page.getByText("USER_SETTINGS_CHANGE", { exact: false }).count(),
      0,
    );
    await page.screenshot({
      path: join(output, "tool-error-continued-light.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await finalReply.waitFor();
    assert.equal(
      await page.getByText("USER_SETTINGS_CHANGE", { exact: false }).count(),
      0,
    );
    await page.screenshot({
      path: join(output, "tool-error-history-mobile-dark.png"),
    });
  }
  console.log(
    before
      ? "已从实际桥接复现 agy 预览失败。"
      : "实际 Chromium 通过新建和已有对话的文件预览，以及执行中发送新要求回归。",
  );
} finally {
  await context?.close();
  const peer = await connectIpc(workerLocation(backend.stateDir).socket).catch(
    () => null,
  );
  try {
    if (peer) {
      const { params } = await peer.call("state");
      await peer
        .call("shutdown")
        .catch(() => process.kill(params.pid, "SIGTERM"));
    }
  } finally {
    peer?.close();
    await app.close();
    process.env.PATH = oldPath;
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    await rm(root, { recursive: true, force: true });
  }
}
