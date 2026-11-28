import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStaticHandler } from "../../server/src/http/static.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const output = process.env.BROWSER_OUTPUT_DIR;
const profile = await mkdtemp(join(tmpdir(), "claudex-secretary-switch-"));
const serve = createStaticHandler(
  process.env.BROWSER_BUILD_DIR || "client/dist",
);
const server = createServer((request, response) => {
  if (serveDemoSession(request, response)) return;
  return serve(
    request,
    response,
    new URL(request.url, "http://local").pathname,
  );
});
await mkdir(output, { recursive: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  viewport: { width: 1440, height: 960 },
  headless: true,
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
try {
  const page = await context.newPage();
  const target = "旧版未分类与 Markdown";
  const history = "已保留的用户问题";
  const fixture = {
    colorMode: "system",
    nativeDelegation: true,
    projectSecretaryHistory: true,
    backendSettings: {
      agy: {
        enabled: true,
        ready: true,
        delegates: {
          codex: { enabled: true },
          claude: { enabled: true },
        },
      },
    },
    codexItems: [
      {
        id: "prior-user",
        type: "userMessage",
        turnId: "prior",
        content: [{ type: "text", text: history }],
      },
      {
        id: "prior-answer",
        type: "agentMessage",
        turnId: "prior",
        text: "原会话中的助手回答。",
      },
    ],
    claudeItems: [],
  };
  await page.addInitScript(backendFixture, fixture);
  await page.goto("http://127.0.0.1:" + server.address().port);
  const switchMode = page.getByRole("button", {
    name: "委派模式",
    exact: true,
  });
  await page.getByText(history, { exact: true }).waitFor();
  assert.equal(await switchMode.getAttribute("aria-pressed"), "false");
  const draft = "原对话中尚未发送的草稿";
  const composer = page.locator(".composer .ProseMirror");
  await composer.fill(draft);
  await switchMode.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => localStorage.getItem("cx-current") === "legacy-secretary",
  );
  await page.getByText(history, { exact: true }).waitFor();
  await page.getByText("原会话中的助手回答。", { exact: true }).waitFor();
  assert.equal(await switchMode.getAttribute("aria-pressed"), "true");
  assert.equal(await composer.innerText(), draft);
  await page.screenshot({
    path: join(output, "secretary-switch-desktop.png"),
    animations: "disabled",
  });
  const zoomPage = await context.newPage();
  await zoomPage.goto("chrome://settings/appearance");
  const zoom = zoomPage.locator("#zoomLevel");
  const metrics = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.waitForFunction(
          (value) => Math.abs(devicePixelRatio - value) < 0.02,
          scale,
        );
        const record = await switchMode.evaluate((control) => {
          const rect = control.getBoundingClientRect();
          return {
            width: innerWidth,
            dpr: devicePixelRatio,
            right: rect.right,
            height: rect.height,
            theme: getComputedStyle(document.documentElement).colorScheme,
          };
        });
        assert(
          Math.abs(record.width - width / scale) <= 1,
          JSON.stringify(record),
        );
        assert(Math.abs(record.dpr - scale) < 0.02);
        assert.equal(record.theme, theme);
        assert(record.right <= record.width + 1 && record.height >= 24);
        metrics.push({ requestedWidth: width, theme, scale, ...record });
      }
    }
  }
  await zoom.selectOption("1");
  await page.screenshot({
    path: join(output, "secretary-switch-mobile.png"),
    animations: "disabled",
  });
  await page.locator(".composer .send-button").click();
  await page.waitForFunction(
    (text) =>
      window.fixtureRequests.some(
        ({ method, params }) =>
          method === "turn/start" &&
          params.threadId === "legacy-secretary" &&
          params.input.some((item) => item.text === text),
      ),
    draft,
  );
  await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
  const collapsed = page.locator(
    '.project-heading > button[aria-expanded="false"]',
  );
  while (await collapsed.count()) await collapsed.first().click();
  await page.locator(".sidebar").getByText(target, { exact: true }).click();
  await page.waitForFunction(
    () => localStorage.getItem("cx-current") === "legacy",
  );
  assert.equal(await switchMode.getAttribute("aria-pressed"), "false");
  await page.getByRole("button", { name: "显示侧栏", exact: true }).waitFor();
  await writeFile(
    join(output, "secretary-switch-geometry.json"),
    JSON.stringify(metrics, null, 2) + "\n",
  );
  console.log("PASS 秘书续接自动选中、既有轮次可见、来源保持普通模式");
  const legacy = await context.newPage();
  await legacy.addInitScript(backendFixture, {
    ...fixture,
    legacySecretary: true,
  });
  await legacy.goto("http://127.0.0.1:" + server.address().port);
  const upgrade = legacy.getByRole("region", { name: "旧版秘书对话" });
  const convert = upgrade.getByRole("button", { name: "转换为干净秘书续接" });
  const ordinary = upgrade.getByRole("button", { name: "恢复普通模式" });
  await convert.waitFor();
  await legacy.getByText(history, { exact: true }).waitFor();
  assert.equal(
    await legacy.getByRole("button", { name: "发送消息" }).count(),
    0,
  );
  assert(
    await legacy.evaluate(
      () =>
        !window.fixtureRequests.some(
          ({ method, params }) =>
            method === "thread/resume" && params.threadId === "legacy",
        ),
    ),
  );
  await legacy.screenshot({
    path: join(output, "secretary-upgrade-desktop.png"),
    animations: "disabled",
  });
  await legacy.setViewportSize({ width: 390, height: 844 });
  await legacy.emulateMedia({ colorScheme: "dark" });
  await legacy.screenshot({
    path: join(output, "secretary-upgrade-mobile.png"),
    animations: "disabled",
  });
  await ordinary.click();
  await legacy.getByRole("button", { name: "发送消息" }).waitFor();
  assert.equal(await upgrade.count(), 0);
  await legacy.reload();
  await convert.waitFor();
  await convert.focus();
  await legacy.keyboard.press("Enter");
  await legacy.waitForFunction(
    () => localStorage.getItem("cx-current") === "legacy-secretary",
  );
  await legacy.getByText(history, { exact: true }).waitFor();
  const scope = legacy.getByText(/原生压缩摘要.*撤销检查点.*用量.*原始附件/);
  await scope.waitFor();
  const notice = await scope.evaluate((element) => {
    const range = document.createRange();
    range.selectNode(element.lastChild);
    const bounds = element.getBoundingClientRect();
    const lines = [...range.getClientRects()];
    return {
      wrapped: lines.length > 1,
      contained: lines.every(
        ({ right, left }) => right <= bounds.right && left >= bounds.left,
      ),
    };
  });
  assert.deepEqual(notice, { wrapped: true, contained: true });
  await legacy.screenshot({
    path: join(output, "secretary-upgrade-complete.png"),
    animations: "disabled",
  });
  console.log(
    "PASS 旧秘书可读、拦截原生恢复和发送、可恢复普通模式或转换，转换后显示保留范围",
  );
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
