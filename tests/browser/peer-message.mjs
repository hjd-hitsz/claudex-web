import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mapNotification,
  mapResult,
} from "../../server/src/backends/identity-mapping.mjs";
import { convertMessage } from "../../server/src/backends/claude/messages.mjs";
import { formatConversationMessage } from "../../server/src/conversation-manager/message.mjs";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output = join(root, ".cache/peer-message", before ? "before" : "after");
const build = before ? join(output, "dist") : join(root, "client/dist");
await mkdir(output, { recursive: true });
const messageId = "2847b3fe-0000-4000-8000-000000000001";
const turnId = "legacy-turn";
const title = "发布验证会话";
const longTitle = "兼容性验证与发布记录核对".repeat(9);
const body = [
  "请核对**安装包**和新版帮助信息，再把发现的问题发回发布会话。",
  "## 验证范围",
  "- 检查全新安装能否完成首次启动。",
  "- 升级后重新打开会话，确认历史可读。",
  "- 在窄屏验证侧栏开合与键盘焦点。",
  "核对完成后，请附上版本号和验证记录。",
].join("\n\n");
const replyBody = `两项检查均通过。\n\n${"已在隔离环境中完成全部验证。".repeat(18)}\n\n**验证记录已归档。**`;
const from = { threadId: "fixture-sender", runtimeId: "codex", title };
const outputText = formatConversationMessage(
  { id: messageId, from, body },
  "claudex_conversations",
);
const native = {
  id: "native-peer-output",
  turnId,
  type: "functionCallOutput",
  namespace: "claudex_conversations",
  name: "thread_chat_message",
  output: outputText,
};
const request = before
  ? native
  : mapResult(
      { data: [{ turnId, item: native }] },
      "codex",
      "thread/items/list",
    ).data[0].item;
const replyId = "d8b0db59-0000-4000-8000-000000000002";
const reply = {
  id: replyId,
  from: { ...from, title: longTitle },
  replyTo: messageId,
  body: replyBody,
};
const claudeId = "191dccb5-0000-4000-8000-000000000003";
const claudeItem = convertMessage(
  {
    uuid: claudeId,
    type: "user",
    origin: { kind: "peer", from: from.threadId },
    message: {
      content: [
        {
          type: "text",
          text: formatConversationMessage(
            {
              id: claudeId,
              from: { ...from, runtimeId: "claude", title: undefined },
              body,
            },
            "claudex_conversation",
          ),
        },
      ],
    },
  },
  "human",
)[0];
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-peer-message-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
});
try {
  const page = await context.newPage();
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(backendFixture, {
    colorMode: "system",
    codexItems: [
      {
        id: "receipt",
        turnId,
        type: "functionCallOutput",
        name: "background_completed",
        output: JSON.stringify({
          results: [
            {
              job_id: "fixture-job",
              status: "succeeded",
              title: "检查安装包",
              duration_ms: 91000,
              exit_code: 0,
              output_tail: "安装和启动均已通过。",
            },
          ],
        }),
      },
      request,
    ],
    claudeItems: [claudeItem],
  });
  await page.route("https://fixture.invalid/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = {
      writeHead(status, headers) {
        return Object.assign(this, { status, headers });
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
    const file = path === "/" ? "index.html" : path.slice(1);
    try {
      await route.fulfill({
        body: await readFile(join(build, file)),
        contentType:
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
            ".svg": "image/svg+xml",
          }[extname(file)] || "text/html",
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  const take = (name) =>
    page.screenshot({
      path: join(output, name + ".png"),
      animations: "disabled",
    });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("https://fixture.invalid/");
  if (before) {
    await page.locator(".process-history > summary").click();
    await page
      .getByRole("button", { name: /工具结果.*thread_chat_message/ })
      .waitFor();
    assert.equal(await page.getByText(title, { exact: true }).count(), 0);
    await take("tool-row");
  } else {
    const layouts = await checkCards(page, take);
    await writeFile(
      join(output, "layouts.json"),
      JSON.stringify(layouts, null, 2),
    );
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}

async function checkCards(page, take) {
  const card = page.locator(".peer-message").first();
  const entry = card.getByRole("button", {
    name: /发布验证会话，会话请求 · 消息 2847b3fe/,
  });
  const history = page.locator(".process-history > summary");
  await entry.waitFor();
  assert.equal(await page.locator(".background-completion-receipt").count(), 1);
  assert.match(
    await card.locator(".delivery-summary-preview").textContent(),
    /核对完成后，请附上版本号和验证记录。$/,
  );
  await take("desktop-light-100-card");
  await history.click();
  assert.equal(
    await page
      .getByRole("button", { name: /工具结果.*thread_chat_message/ })
      .count(),
    0,
  );
  await history.click();
  await entry.press("Enter");
  await card.getByRole("heading", { name: "验证范围", exact: true }).waitFor();
  assert.equal(await card.locator(".markdown strong").textContent(), "安装包");
  await card
    .getByText("核对完成后，请附上版本号和验证记录。", { exact: true })
    .waitFor();
  assert.equal(await entry.getAttribute("aria-expanded"), "true");
  await take("desktop-light-100-expanded");
  await entry.press("Space");
  assert.equal(await entry.getAttribute("aria-expanded"), "false");

  const live = mapNotification(
    {
      method: "item/completed",
      params: {
        threadId: "legacy",
        turnId,
        item: {
          ...native,
          id: replyId,
          output: formatConversationMessage(reply, "claudex_conversations"),
        },
      },
    },
    "codex",
  );
  await page.evaluate(
    (message) =>
      window.backendSocket.onmessage({ data: JSON.stringify(message) }),
    live,
  );
  const replyCard = page.locator(".peer-message").nth(1);
  const replyEntry = replyCard.getByRole("button", {
    name: /会话回复 · 消息 d8b0db59/,
  });
  await replyEntry.waitFor();
  await page.emulateMedia({ colorScheme: "dark" });
  await replyEntry.scrollIntoViewIfNeeded();
  await take("desktop-dark-live-reply");
  await replyEntry.click();
  await replyCard.getByText("验证记录已归档。", { exact: true }).waitFor();
  assert.ok(
    (await replyCard.locator(".markdown").textContent()).includes(
      "已在隔离环境中完成全部验证。".repeat(18),
    ),
  );

  const appearance = await context.newPage();
  await appearance.goto("chrome://settings/appearance");
  const zoom = appearance.locator("#zoomLevel");
  await zoom.waitFor();
  const layouts = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await zoom.selectOption(String(scale));
        await page.reload();
        await entry.waitFor();
        const name = `${width === 390 ? "mobile" : "desktop"}-${theme}-${Math.round(scale * 100)}`;
        const layout = await entry.evaluate((el) => ({
          dpr: devicePixelRatio,
          viewport: innerWidth,
          button: el.getBoundingClientRect().toJSON(),
          toolsLeft: document
            .querySelector(".context-tools")
            .getBoundingClientRect().left,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        }));
        assert.ok(Math.abs(layout.dpr - scale) < 0.02);
        assert.ok(Math.abs(layout.viewport - width / scale) <= 1);
        assert.ok(
          layout.button.left >= 0 && layout.button.right <= layout.viewport + 1,
        );
        assert.ok(layout.button.right <= layout.toolsLeft + 1);
        assert.ok(layout.button.height > 30);
        assert.equal(layout.horizontalOverflow, false);
        if (scale === 1.5) await take(name + "-card");
        await entry.press("Enter");
        const body = card.locator(".peer-message-body");
        await body.getByText("核对完成后，请附上版本号和验证记录。").waitFor();
        const overflow = await body.evaluate(
          (el) => el.scrollWidth > el.clientWidth + 1,
        );
        assert.equal(overflow, false);
        if (width === 390 || scale === 1.5) {
          await card.scrollIntoViewIfNeeded();
          await take(name + "-expanded");
        }
        layouts.push({
          width,
          theme,
          scale,
          ...layout,
          bodyOverflow: overflow,
        });
      }
    }
  }
  await zoom.selectOption("1");
  await appearance.close();
  await page.reload();
  await entry.waitFor();
  await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
  await page.locator(".sidebar").waitFor({ state: "visible" });
  await take("mobile-dark-sidebar-open");
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.activeElement.closest(".sidebar"));
  await entry.press("Enter");
  await take("mobile-dark-sidebar-closed");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .locator(".project-heading > button")
    .filter({ hasText: "project" })
    .click();
  await page.getByText("Claude 原生消息归属", { exact: true }).click();
  const claude = page.getByRole("button", {
    name: /未命名会话，会话请求 · 消息 191dccb5/,
  });
  await claude.waitFor();
  await claude.click();
  await page.getByRole("heading", { name: "验证范围", exact: true }).waitFor();
  await take("claude-dark-untitled");
  return layouts;
}
