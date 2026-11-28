import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { backendFixture } from "../helpers/backend-browser-fixture.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const output =
  process.env.BROWSER_OUTPUT_DIR ||
  join(root, ".cache/delivery-sources", before ? "before" : "after");
const build =
  process.env.BROWSER_BUILD_DIR ||
  (before ? join(output, "dist") : join(root, "client/dist"));
const turnId = "legacy-turn";
const taskId = "a7ed34b1";
const stepId = "cd8214ef";
const backgroundTitle = "安装包验证与离线部署检查";
const peerTitle = "发布协调与版本核对会话";
const delegationTitle =
  "核对升级后的历史兼容性、旧会话的工具回执、只读会话的执行记录和现有归档的恢复顺序，再记录两种安装方式的最终校验结果";
const peerBody = [
  "请把**升级验证结果**发给发布会话。桌面端已经完成首次安装与归档恢复，窄屏也验证了侧栏开关和键盘焦点。请附上实际用到的安装包版本、验证记录及两个窗口尺寸的截图。",
  "发布前请再核对旧对话中的工具结果和可展开正文。恢复后仍在执行的任务要单独记录，方便发布负责人判断是否需要等待。完成以后，把可公开的日志路径也附到回复中。",
  "如果离线环境有差异，请说明依赖来源、操作系统版本和可以复现的步骤。",
].join("\n\n");
const backgroundPreview =
  "安装与首次启动均已通过。离线环境中的依赖已核对，旧版配置和用户数据在升级后可读。桌面和窄屏浏览器均已重新加载最新资源。验证过程保留了独立安装目录、产物校验值和完整的启动日志，发布前可以逐项核对。";
const delegationPreview =
  "已检查旧版历史和升级后的归档。抽查的旧会话均可打开，工具回执和正文仍可展开。归档恢复时保留原有顺序，三类摘要卡片都能找到对应的来源和后续操作。测试使用独立配置目录，验证结果与对应的记录已整理在升级报告中。";
const statuses = [
  "已完成 · 1分31秒 · 退出码 0",
  "会话回复 · 消息 2847b3fe",
  "Claude Code · 已完成",
];
const labels = ["后台终端", "会话来信", "委派结果"];
await mkdir(output, { recursive: true });

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-delivery-sources-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1180 },
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
              title: backgroundTitle,
              duration_ms: 91000,
              exit_code: 0,
              output_tail: backgroundPreview,
            },
          ],
        }),
      },
      {
        id: "peer",
        type: "peerMessage",
        turnId,
        from: { threadId: "fixture-source", title: peerTitle },
        messageId: "2847b3fe-0000-4000-8000-000000000001",
        replyTo: "d8b0db59-0000-4000-8000-000000000002",
        body: peerBody,
      },
      {
        id: "delegate",
        type: "subAgentActivity",
        turnId,
        agentThreadId: "backend:claude:fixture",
        kind: "completed",
        delegation: {
          taskId,
          target: "claude",
          summaries: {
            [stepId]: {
              title: delegationTitle,
              preview: delegationPreview,
            },
          },
        },
      },
      {
        id: "delegation-result",
        turnId,
        type: "delegationResult",
        taskId,
        stepId,
        target: "claude",
        status: "completed",
      },
    ],
    claudeItems: [],
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
  const cards = page.locator(".conversation .delivery-summary");
  const take = (name) =>
    page.screenshot({
      path: join(output, name + ".png"),
      animations: "disabled",
    });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("https://fixture.invalid/");
  await cards.nth(2).waitFor();
  assert.equal(await cards.count(), 3);
  assert.deepEqual(
    (await cards.locator(".delivery-summary-status").allTextContents()).map(
      (status) => status.replaceAll("\u00a0", " "),
    ),
    statuses,
  );
  if (before) {
    await take("desktop-light-100");
    await page.emulateMedia({ colorScheme: "dark" });
    await take("desktop-dark-100");
  } else {
    const layouts = await checkSources(page, cards, take);
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

async function checkSources(page, cards, take) {
  assert.deepEqual(
    await cards.locator(".delivery-summary-source").allTextContents(),
    labels,
  );
  const names = [
    `后台终端，${backgroundTitle}，${statuses[0]}，查看输出`,
    `会话来信，${peerTitle}，${statuses[1]}，展开正文`,
    `委派结果，${delegationTitle}，${statuses[2]}，查看执行记录`,
  ];
  for (const [index, name] of names.entries()) {
    assert.equal(
      await page.getByRole("button", { name, exact: true }).count(),
      1,
    );
    assert.equal(
      await cards
        .nth(index)
        .locator('.delivery-summary-source svg[aria-hidden="true"]')
        .count(),
      1,
    );
  }
  const icons = await cards
    .locator(".delivery-summary-source svg")
    .evaluateAll((elements) =>
      elements.map((icon) => icon.getAttribute("class")),
    );
  assert.equal(new Set(icons).size, 3);

  const appearance = await context.newPage();
  await appearance.goto("chrome://settings/appearance");
  const zoom = appearance.locator("#zoomLevel");
  await zoom.waitFor();
  const layouts = [];
  for (const width of [1920, 1440, 1280, 1024, 390]) {
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      const scales = [1440, 390].includes(width) ? [0.8, 1, 1.25, 1.5, 2] : [1];
      for (const scale of scales) {
        await page.setViewportSize({
          width,
          height:
            scale === 2
              ? 1800
              : width === 390
                ? 1270
                : width < 1440
                  ? 900
                  : 1180,
        });
        await zoom.selectOption(String(scale));
        await page.reload();
        await cards.nth(2).waitFor();
        const layout = await cards.evaluateAll((elements) => {
          const box = (el) => el.getBoundingClientRect().toJSON();
          const conversation = box(document.querySelector(".conversation"));
          const sidebar = document.querySelector(".sidebar");
          const column = document.querySelector(".message-column");
          const columnStyle = getComputedStyle(column);
          const contentWidth =
            box(column).width -
            parseFloat(columnStyle.paddingLeft) -
            parseFloat(columnStyle.paddingRight);
          function renderedLines(element) {
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
            );
            const range = document.createRange();
            const lines = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (const { 0: character, index } of node.textContent.matchAll(
                /./gu,
              )) {
                range.setStart(node, index);
                range.setEnd(node, index + character.length);
                const rect = range.getBoundingClientRect();
                if (!rect.width) continue;
                const top = rect.top + rect.height / 2;
                let line = lines.find((line) => Math.abs(line.top - top) < 4);
                if (!line) {
                  line = { top, text: "" };
                  lines.push(line);
                }
                line.text += character;
              }
            }
            return lines
              .map(({ text }) => text.replaceAll("\u00a0", " ").trim())
              .filter(Boolean);
          }
          return {
            dpr: devicePixelRatio,
            viewport: innerWidth,
            horizontalOverflow:
              document.documentElement.scrollWidth > innerWidth,
            toolsLeft: box(document.querySelector(".context-tools")).left,
            sidebarVisible:
              box(sidebar).right > 0 &&
              getComputedStyle(sidebar).visibility === "visible",
            contentWidth,
            conversation,
            cards: elements.map((el) => {
              const source = el.querySelector(".delivery-summary-source");
              const title = el.querySelector(".delivery-summary-title");
              const status = el.querySelector(".delivery-summary-status");
              const arrow = el.querySelector(".delivery-summary-arrow");
              const preview = el.querySelector(".delivery-summary-preview");
              return {
                box: box(el),
                source: box(source),
                title: box(title),
                status: box(status),
                arrowLeft: box(arrow).left,
                lineHeight: parseFloat(getComputedStyle(title).lineHeight),
                clampedTitle: title.scrollHeight > title.clientHeight + 1,
                sourceFontSize: parseFloat(getComputedStyle(source).fontSize),
                titleFontSize: parseFloat(getComputedStyle(title).fontSize),
                clippedStatus:
                  status.scrollHeight > status.clientHeight + 1 ||
                  status.scrollWidth > status.clientWidth + 1,
                statusLines: renderedLines(status),
                previewLines:
                  box(preview).height /
                  parseFloat(getComputedStyle(preview).lineHeight),
              };
            }),
          };
        });
        assert.ok(Math.abs(layout.dpr - scale) < 0.02);
        assert.ok(Math.abs(layout.viewport - width / scale) <= 1);
        assert.equal(layout.horizontalOverflow, false);
        for (const [index, card] of layout.cards.entries()) {
          assert.ok(
            card.box.left >= 0 && card.box.right <= layout.toolsLeft + 1,
          );
          assert.ok(card.source.bottom <= card.title.top);
          assert.ok(card.title.bottom <= card.status.top);
          assert.ok(card.status.right <= card.arrowLeft);
          assert.ok(card.sourceFontSize < card.titleFontSize);
          assert.ok(card.title.height <= 2 * card.lineHeight + 1);
          assert.equal(card.clippedStatus, false);
          assert.equal(
            card.statusLines.join("\n").replaceAll("·\n", "· "),
            statuses[index],
            `${width}px × ${scale} ${labels[index]} 的状态换行：${card.statusLines.join(" / ")}`,
          );
        }
        const screenshot =
          width === 390
            ? [1.25, 1.5, 2].includes(scale)
            : [1, 1.5, 2].includes(scale);
        if (screenshot) {
          assert.ok(
            layout.cards.every(
              ({ box }) =>
                box.top >= layout.conversation.top - 1 &&
                box.bottom <= layout.conversation.bottom + 1,
            ),
            `三张卡片应同时可见（${width}px，${theme}，${scale * 100}%）：${JSON.stringify(layout)}`,
          );
          await take(`${width}-${theme}-${Math.round(scale * 100)}`);
        }
        layouts.push({ width, theme, scale, ...layout });
      }
    }
  }
  assert.ok(layouts.some(({ cards }) => cards[2].clampedTitle));
  for (const { width, scale, contentWidth, cards } of layouts) {
    const expected = Math.min(
      contentWidth,
      Math.max(352, Math.min(contentWidth * 0.56, 640)),
    );
    for (const card of cards) {
      assert.ok(
        Math.abs(card.box.width - expected) <= 1,
        `${width}px × ${scale}：卡片宽 ${card.box.width}，期望 ${expected}`,
      );
      assert.ok(Math.abs(card.box.right - cards[0].box.right) <= 1);
      assert.ok(card.previewLines <= 3.05);
    }
    if (width === 390) {
      assert.ok(
        Math.abs(cards[0].box.width - Math.min(352, contentWidth)) <= 1,
      );
    }
  }
  for (let index = 0; index < labels.length; index++) {
    assert.ok(
      layouts.some(
        ({ width, cards }) =>
          width === 390 && cards[index].statusLines.length > 1,
      ),
    );
    assert.ok(
      layouts.some(
        ({ width, cards }) =>
          width >= 1024 && cards[index].previewLines >= 2.95,
      ),
    );
  }
  await zoom.selectOption("1");
  await appearance.close();
  await page.setViewportSize({ width: 390, height: 1180 });
  await page.reload();
  await cards.nth(2).waitFor();
  await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.activeElement.closest(".sidebar"));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
  await page.locator(".sidebar").waitFor({ state: "visible" });
  await take("1280-light-sidebar-open");

  await page.setViewportSize({ width: 1440, height: 1180 });
  const peer = page.getByRole("button", { name: names[1], exact: true });
  await peer.press("Enter");
  await page
    .locator(".peer-message-body")
    .getByText("升级验证结果", { exact: true })
    .waitFor();
  const collapse = page.getByRole("button", {
    name: names[1].replace("展开正文", "收起正文"),
    exact: true,
  });
  assert.equal(await collapse.getAttribute("aria-expanded"), "true");
  const expanded = page.locator(".peer-message-body");
  const bodyLayout = await expanded.evaluate((body) => ({
    width: body.getBoundingClientRect().width,
    cardWidth: body.previousElementSibling.getBoundingClientRect().width,
    overflow: body.scrollWidth > body.clientWidth + 1,
  }));
  assert.ok(bodyLayout.width > 500);
  assert.equal(bodyLayout.width, bodyLayout.cardWidth);
  assert.equal(bodyLayout.overflow, false);
  await take("1440-light-expanded");
  await collapse.press("Space");
  assert.equal(await peer.getAttribute("aria-expanded"), "false");
  await page.getByRole("button", { name: names[0], exact: true }).click();
  await page
    .getByRole("region", { name: "后台终端输出", exact: true })
    .waitFor();
  await page.getByRole("button", { name: names[2], exact: true }).click();
  await page.getByRole("region", { name: /委派对话/ }).waitFor();
  return layouts;
}
