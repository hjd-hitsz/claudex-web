import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { historyPerformanceFixture } from "../fixtures/history-performance.mjs";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { createCodeLineSearch } from "../../server/src/workspace/code-line-search.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, ".cache/code-line-paste/sources");
await mkdir(output, { recursive: true });

function mockCodeLineLookup() {
  const send = WebSocket.prototype.send;
  const fixture = window.historyFixture;
  fixture.lookups = [];
  WebSocket.prototype.send = function (raw) {
    const request = JSON.parse(raw);
    if (request.method === "turn/start" && fixture.holdSubmission) {
      fixture.requests.push(request);
      fixture.finishSubmission = () => {
        fixture.holdSubmission = false;
        fixture.finishSubmission = undefined;
        this.onmessage({
          data: JSON.stringify({ id: request.id, result: {} }),
        });
      };
      return;
    }
    if (request.method !== "lan/workspace/codeLine")
      return send.call(this, raw);
    fixture.lookups.push({
      line: request.params.line,
      finish: (matches) =>
        this.onmessage({
          data: JSON.stringify({
            id: request.id,
            result: { matches },
          }),
        }),
    });
  };
}

const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};
const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response)) return;
  try {
    const path = new URL(request.url, "http://fixture").pathname;
    let body = await readFile(
      join(root, "client/dist", path === "/" ? "index.html" : path),
    );
    if (path === "/")
      body = String(body).replace(
        "<head>",
        `<head><script>{
          (${historyPerformanceFixture.toString()})();
          (${mockCodeLineLookup.toString()})();
        }</script>`,
      );
    response
      .writeHead(200, {
        "Content-Type":
          path === "/"
            ? "text/html"
            : types[extname(path)] || "application/octet-stream",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "claudex-code-line-browser-"));
const extension = join(profile, "zoom");
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
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  viewport: { width: 1440, height: 960 },
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
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
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.getByRole("button", { name: /^简短对话/ }).click();
  const field = page.locator(".markdown-composer .ProseMirror");
  const chips = page.locator(".composer .code-file-attachment");
  await field.click();
  await page.keyboard.insertText("请检查 ");
  const paste = (line, whole = true, mode = "python", html = "") =>
    field.evaluate(
      (editor, { line, whole, mode, html }) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", line + (whole ? "\n" : ""));
        if (html) clipboardData.setData("text/html", html);
        if (mode)
          clipboardData.setData(
            "vscode-editor-data",
            JSON.stringify({
              version: 1,
              mode,
              isFromEmptySelection: whole,
              multicursorText: null,
              isBlock: false,
            }),
          );
        editor.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
        return editor.textContent.includes(line.split("\n")[0]);
      },
      { line, whole, mode, html },
    );
  const finish = (line, matches) =>
    page.evaluate(
      ({ line, matches }) => {
        const request = window.historyFixture.lookups.findLast(
          (entry) => entry.line === line,
        );
        if (request?.line !== line)
          throw new Error("查找的代码行与剪贴板内容不一致");
        request.finish(matches);
      },
      { line, matches },
    );
  const unique = { path: "/demo/history/engine/edges.py", line: 27 };
  const ambiguous = [
    { path: "/demo/history/engine/worker_cache.py", line: 32 },
    { path: "/demo/history/legacy/worker_cache_previous.py", line: 20 },
    { path: "/demo/history/tests/test_worker_cache.py", line: 63 },
  ];
  const code = "    parent_states = tree[index]";
  assert(await paste(code));
  assert.equal(await chips.count(), 0);
  await finish(code, [unique]);
  await chips.first().waitFor();
  const source = field.getByRole("button", { name: "查看匹配的文件位置" });
  await source.click();
  const preview = page.getByRole("tooltip").filter({ hasText: unique.path });
  await preview.waitFor();
  assert.match(await preview.textContent(), /edges\.py:27/);
  assert.match(await preview.textContent(), /parent_states = tree\[index\]/);
  const appearance = await field.evaluate((editor) => {
    const mark = editor.querySelector(".pasted-code-line");
    const code = mark.closest("code") ?? mark.querySelector("code");
    const indent = editor.querySelector(".pasted-code-indent");
    const range = document.createRange();
    range.selectNodeContents(indent);
    return {
      background: getComputedStyle(code).backgroundColor,
      indent: range.getBoundingClientRect().width,
    };
  });
  assert.equal(appearance.background, "rgba(0, 0, 0, 0)");
  assert(appearance.indent <= 10, JSON.stringify(appearance));
  assert.match(await chips.first().textContent(), /edges\.py:27/);
  assert.equal(await field.locator(".pasted-code-line").count(), 1);
  await page.getByRole("button", { name: "移除代码文件候选" }).click();
  await chips.first().waitFor({ state: "detached" });
  assert.equal(await source.count(), 0);
  assert.match(await field.textContent(), /parent_states = tree\[index\]/);
  await field.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("请检查 ");
  assert(await paste(code));
  await finish(code, [unique]);
  await chips.first().waitFor();
  await page.keyboard.insertText(" 的返回值，以及 ");
  const other = "    cache = build_worker_cache()";
  assert(await paste(other));
  await finish(other, ambiguous);
  await chips.nth(1).waitFor();
  await page.keyboard.insertText(" 的初始化。");
  await chips.nth(1).locator(".code-location").focus();
  const allMatches = page
    .getByRole("tooltip")
    .filter({ hasText: ambiguous[1].path });
  await allMatches.waitFor();
  assert.deepEqual(
    await allMatches.locator(".code-file-preview-path > div").allTextContents(),
    ambiguous.map(({ path, line }) => `${path}:${line}`),
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("tooltip")
    .filter({ hasText: ambiguous[1].path })
    .waitFor({ state: "detached" });
  assert.match(await field.textContent(), /的初始化。/);
  assert.match(await chips.nth(1).innerText(), /worker_cache\.py/);
  assert.deepEqual(
    await chips.nth(1).locator(".code-file-line").allTextContents(),
    [":32"],
  );
  assert.equal(
    await chips.nth(1).locator(".code-file-count").textContent(),
    "+2",
  );
  const firstWidth = (
    await chips.first().locator(".code-location").boundingBox()
  ).width;
  assert.equal(await field.locator(".code-file-attachment").count(), 0);
  await field.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(" 最后核对 ");
  const tailCode = "return costs";
  assert(await paste(tailCode, false, null));
  await finish(tailCode, [
    { path: "/demo/history/engine/costs.py", line: 56 },
    { path: "/demo/history/legacy/costs_old.py", line: 19 },
  ]);
  await chips.nth(2).waitFor();
  assert.equal(
    await chips.nth(2).locator(".code-file-count").textContent(),
    "+1",
  );
  await page.mouse.move(5, 5);
  await page.locator(".composer").screenshot({
    path: join(output, "attachment-rail.png"),
    animations: "disabled",
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.locator(".composer").screenshot({
    path: join(output, "attachment-rail-dark.png"),
    animations: "disabled",
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  const layout = await chips.evaluateAll((groups) =>
    groups.map((group) => {
      const frame = group.getBoundingClientRect();
      const remove = group.lastElementChild.getBoundingClientRect();
      const next = group.nextElementSibling?.getBoundingClientRect();
      return {
        border: getComputedStyle(group).borderInlineEndWidth,
        width: frame.width,
        fileBorders: [...group.querySelectorAll(".code-location")].map(
          (file) => getComputedStyle(file).borderInlineEndWidth,
        ),
        trailing: frame.right - remove.right,
        gap: next ? next.left - frame.right : 0,
      };
    }),
  );
  for (const group of layout) {
    assert.equal(group.border, "1px");
    assert(group.width === layout[0].width, JSON.stringify(layout));
    assert(group.fileBorders.every((border) => border === "0px"));
    assert(group.trailing >= 0 && group.trailing <= 2, JSON.stringify(layout));
    assert(group.gap >= 0 && group.gap <= 6, JSON.stringify(layout));
  }
  console.log(
    "一、三、两个候选的标签宽度",
    layout.map(({ width }) => width),
  );
  await chips.nth(2).getByRole("button", { name: "移除代码文件候选" }).click();
  assert(firstWidth < 125, `单个文件标签宽度 ${firstWidth}px`);
  await chips.nth(1).locator(".code-location").hover();
  const peek = page.getByRole("tooltip").filter({ hasText: ambiguous[1].path });
  await peek.waitFor();
  const composerBounds = await page.locator(".composer").boundingBox();
  const peekBounds = await peek.boundingBox();
  await page.screenshot({
    path: join(output, "attachment-preview.png"),
    clip: {
      x: composerBounds.x,
      y: peekBounds.y - 4,
      width: composerBounds.width,
      height: composerBounds.y + composerBounds.height - peekBounds.y + 4,
    },
  });
  await page.mouse.move(5, 5);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
        assert.equal(
          await worker.evaluate(
            async ({ url, zoom }) => {
              const [tab] = await chrome.tabs.query({ url });
              await chrome.tabs.setZoom(tab.id, zoom);
              return chrome.tabs.getZoom(tab.id);
            },
            { url: page.url(), zoom },
          ),
          zoom,
        );
        await page.waitForFunction(
          ({ zoom, width }) =>
            Math.abs(devicePixelRatio - zoom) < 0.02 &&
            Math.abs(innerWidth - width / zoom) < 2,
          { zoom, width },
        );
        const metrics = await chips.nth(1).evaluate((chip) => {
          const files = [...chip.querySelectorAll(".code-file-name")];
          const lines = [...chip.querySelectorAll(".code-file-line")];
          const outer = chip.getBoundingClientRect();
          const rail = chip
            .closest(".annotation-attachments")
            .getBoundingClientRect();
          return {
            width: outer.width,
            firstWidth:
              chip.parentElement.firstElementChild.getBoundingClientRect()
                .width,
            editor: chip.closest(".annotation-attachments").clientWidth,
            dpr: devicePixelRatio,
            viewport: innerWidth,
            truncated: files.some(
              (file) => file.scrollWidth > file.clientWidth,
            ),
            clickTargets: [...chip.querySelectorAll("button")].every(
              (button) => button.getBoundingClientRect().height >= 20,
            ),
            linesVisible: lines.every((line) => {
              const box = line.getBoundingClientRect();
              return (
                box.width > 0 &&
                box.left >= outer.left &&
                box.right <= outer.right &&
                box.top >= rail.top &&
                box.bottom <= rail.bottom
              );
            }),
          };
        });
        assert(Math.abs(metrics.dpr - zoom) < 0.02);
        assert(Math.abs(metrics.viewport - width / zoom) < 2);
        assert(metrics.width > 0 && metrics.width <= metrics.editor);
        assert.equal(metrics.width, metrics.firstWidth);
        assert(metrics.truncated);
        assert(metrics.clickTargets);
        assert(metrics.linesVisible);
        if (zoom === 1)
          await page.screenshot({
            animations: "disabled",
            path: join(
              output,
              `${width === 390 ? "mobile" : "desktop"}-${theme}.png`,
            ),
          });
      }
    }
  }
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.tabs.setZoom(tab.id, 1);
  }, page.url());
  const showSidebar = page.getByRole("button", { name: "显示侧栏" });
  const hideSidebar = page.getByRole("button", { name: "收起侧栏" });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await hideSidebar.waitFor();
  await page.screenshot({ path: join(output, "mobile-sidebar.png") });
  await hideSidebar.click();
  await showSidebar.waitFor();
  assert(
    await showSidebar.evaluate((button) => button === document.activeElement),
  );
  await field.focus();
  await page.keyboard.press("Control+End");
  const plain = "run";
  assert(await paste(plain));
  await finish(plain, []);
  assert.equal(await chips.count(), 2);
  assert(await paste("tree", false));
  await finish("tree", [...ambiguous, unique]);
  assert.equal(await chips.count(), 2);
  const lookups = await page.evaluate(
    () => window.historyFixture.lookups.length,
  );
  assert.equal(lookups, 6);
  await page.keyboard.insertText(" ");
  const edited = "return next_state";
  assert(await paste(edited));
  await page.keyboard.press("Backspace");
  await finish(edited, [unique]);
  assert.equal(await chips.count(), 2);
  assert.match(await field.textContent(), /return next_stat$/);
  await page.screenshot({ path: join(output, "mobile-ordinary-paste.png") });
  await page.setViewportSize({ width: 1440, height: 960 });
  const longThread = page.getByRole("button", { name: /^超长对话性能验证/ });
  const shortThread = page.getByRole("button", { name: /^简短对话/ });
  await longThread.click();
  await chips.first().waitFor({ state: "detached" });
  await shortThread.click();
  await chips.nth(1).waitFor();
  await source.nth(1).waitFor();
  await field.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(" 选中的代码 ");
  const manualLine = "normalize_cost(tree)";
  assert(await paste(manualLine, false));
  assert.equal(await chips.count(), 2);
  await finish(manualLine, [
    { path: "/demo/history/engine/normalize.py", line: 8 },
  ]);
  await chips.nth(2).waitFor();
  await page.keyboard.insertText(" 远程剪贴板 ");
  const remoteLine = "cost = total_cost + step_cost";
  assert(
    await paste(
      remoteLine,
      false,
      null,
      `<div><span style="color: #c00">${remoteLine}</span></div>`,
    ),
  );
  assert.equal(await chips.count(), 3);
  await finish(remoteLine, [
    { path: "/demo/history/engine/costs.py", line: 41 },
  ]);
  await chips.nth(3).waitFor();
  await source.nth(3).waitFor();
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "single-line-sources.png") });
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  const sentText = () =>
    page.evaluate(() =>
      window.historyFixture.requests
        .find(({ method }) => method === "turn/start")
        ?.params.input.map((part) => part.text)
        .join("\n"),
    );
  await send.click();
  await page.waitForFunction(() =>
    window.historyFixture.requests.some(
      ({ method }) => method === "turn/start",
    ),
  );
  const attached = await sentText();
  for (const file of [unique, ...ambiguous])
    assert(attached.includes(`\n- ${file.path}:${file.line}\n`));
  assert.match(attached, /粘贴代码已定位。需要源码上下文时，请直接读取/);
  assert.match(attached, /同一段粘贴代码匹配到多处/);
  await chips.first().waitFor({ state: "detached", timeout: 3000 });
  assert.equal(await field.textContent(), "");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.getByRole("button", { name: /^简短对话/ }).click();
  await field.waitFor();
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await field.focus();
  const duplicate = "class Costs:";
  const duplicateLocation = [
    { path: "/demo/history/engine/costs.py", line: 4 },
  ];
  await page.keyboard.insertText("请核对 ");
  const requestsBefore = await page.evaluate(
    () => window.historyFixture.lookups.length,
  );
  assert(await paste(duplicate));
  assert(await paste(duplicate));
  assert.equal(
    await page.evaluate(() => window.historyFixture.lookups.length),
    requestsBefore + 1,
  );
  await finish(duplicate, duplicateLocation);
  await source.nth(1).waitFor();
  assert.equal(await chips.count(), 1);
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "duplicate-code-one-source.png") });
  await page.keyboard.press("Control+z");
  assert.equal(await source.count(), 1);
  assert.equal(await chips.count(), 1);
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "undo-one-source.png") });
  await page.keyboard.press("Control+z");
  assert.equal(await source.count(), 0);
  assert.equal(await chips.count(), 0);
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "undo-last-source.png") });
  await page.keyboard.press("Control+y");
  assert.equal(await source.count(), 1);
  assert.equal(await chips.count(), 1);
  await field.evaluate((editor) => {
    const code = editor.querySelector("code");
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press("Backspace");
  assert.equal(await source.count(), 0);
  assert.equal(await chips.count(), 0);
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "delete-last-source.png") });
  const pending = "class NotYetMatched:";
  assert(await paste(pending));
  await page.keyboard.press("Control+z");
  await finish(pending, duplicateLocation);
  assert.equal(await chips.count(), 0);
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("请检查这段代码， 后半句继续说明原因。");
  await field.evaluate((editor) => {
    const text = editor.querySelector("p").firstChild;
    const range = document.createRange();
    range.setStart(text, "请检查这段代码，".length + 1);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  const lines = [
    "def inspect_edges(tree):",
    "    root = tree.root",
    "    states = root.parent_states",
    "    result = normalize(states)",
    "    return result",
  ];
  const selectParagraph = (paragraph, offset) =>
    field.evaluate(
      (editor, { paragraph, offset }) => {
        const text = editor.querySelectorAll("p")[paragraph].firstChild;
        const range = document.createRange();
        range.setStart(text, offset);
        range.collapse(true);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      },
      { paragraph, offset },
    );
  const fragment = field.locator(".pasted-code-entry");
  const multilineCode = fragment.locator("code");
  const arrow = fragment.getByRole("button", {
    name: "移动光标到粘贴代码末尾",
  });
  const before = "请检查这段代码， ";
  const after = "后半句继续说明原因。";
  const pasteMiddle = async () => {
    await field.focus();
    await selectParagraph(0, before.length);
    assert(await paste(lines.join("\n"), false));
    await fragment.waitFor();
    assert.equal(await multilineCode.textContent(), lines.join("\n"));
    assert.equal(await arrow.textContent(), "↗");
    assert.equal(await field.locator("pre, .milkdown-code-block").count(), 0);
    assert.equal(
      await fragment.evaluate((entry) => entry.parentElement.tagName),
      "P",
    );
    assert.equal(await field.locator(":scope > p").count(), 1);
    assert.equal(
      await field.textContent(),
      before + lines.join("\n") + "↗" + after,
    );
  };
  await pasteMiddle();
  const geometry = await fragment.evaluate((entry) => {
    const box = (text, end = false) => {
      const offset = end ? text.length - 1 : 0;
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      return range.getBoundingClientRect();
    };
    const first = box(entry.querySelector("code").firstChild);
    const last = box(entry.querySelector("code").firstChild, true);
    const lead = box(entry.previousSibling, true);
    const tail = box(entry.nextSibling);
    const arrow = entry.querySelector("button").getBoundingClientRect();
    return {
      leadDifference: Math.abs(first.bottom - lead.bottom),
      tailDifference: Math.abs(last.bottom - tail.bottom),
      arrowTopDelta: arrow.top - last.top,
      arrowBottomDelta: arrow.bottom - last.bottom,
      firstLineFollowsText: first.left >= lead.right - 2,
      lastLinePrecedesText: last.right <= tail.left,
      background: getComputedStyle(entry.querySelector("code")).backgroundColor,
    };
  });
  assert(geometry.leadDifference <= 3, JSON.stringify(geometry));
  assert(geometry.tailDifference <= 3, JSON.stringify(geometry));
  assert(geometry.firstLineFollowsText, JSON.stringify(geometry));
  assert(geometry.lastLinePrecedesText, JSON.stringify(geometry));
  assert(geometry.arrowTopDelta >= -5, JSON.stringify(geometry));
  assert(geometry.arrowBottomDelta <= 0, JSON.stringify(geometry));
  assert.equal(geometry.background, "rgba(0, 0, 0, 0)");
  console.log("五行代码编辑区基线与尾部箭头", geometry);
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "five-line-inline.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  if (await page.locator(".sidebar.mobile-open").count())
    await hideSidebar.click();
  await showSidebar.waitFor();
  await page.locator(".composer").screenshot({
    path: join(output, "five-line-mobile-dark.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.locator("[data-composer-expand]").click();
  const expanded = page.getByRole("dialog", { name: "编辑消息", exact: true });
  await expanded.waitFor();
  assert.equal(await multilineCode.textContent(), lines.join("\n"));
  assert.equal(await field.locator("pre, .milkdown-code-block").count(), 0);
  await page.getByRole("button", { name: "关闭编辑窗口" }).click();
  await arrow.click();
  await page.keyboard.press("Backspace");
  assert.equal(await fragment.count(), 0);
  assert.equal(await field.textContent(), before + after);
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "five-line-removed.png") });
  await page.keyboard.press("Control+z");
  assert.equal(await multilineCode.textContent(), lines.join("\n"));
  await field.focus();
  await selectParagraph(0, before.length);
  await page.keyboard.press("Delete");
  assert.equal(await fragment.count(), 0);
  assert.equal(await field.textContent(), before + after);
  await pasteMiddle();
  await page.getByRole("button", { name: /^超长对话性能验证/ }).click();
  await fragment.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /^简短对话/ }).click();
  await multilineCode.waitFor();
  assert.equal(await multilineCode.textContent(), lines.join("\n"));
  assert.equal(await field.locator("pre, .milkdown-code-block").count(), 0);
  assert.equal(
    await field.textContent(),
    before + lines.join("\n") + "↗" + after,
  );
  await field.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("- ");
  await page.keyboard.insertText("先核对现有实现");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("确认代价计算");
  await page.keyboard.press("Enter");
  await field.locator("li").nth(2).waitFor();
  const editorParagraphs = await field.locator(":scope > p").count();
  const classLines = [
    "class Costs:",
    "    def __init__(self):",
    "        self.costs = np.array([0.0])",
  ];
  const classCode = classLines.join("\n");
  const cwd = join(profile, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "costs.py"), "\n".repeat(3) + classCode + "\n");
  const search = createCodeLineSearch();
  const found = (await search.search({ cwd, line: classCode })).matches;
  search.close();
  assert.equal(found[0]?.line, 4);
  const classLocation = {
    path: "/demo/history/engine/costs.py",
    line: found[0].line,
  };
  await paste("\n\n" + classCode + "\n \n", false);
  assert.equal(await field.locator("li").count(), 3);
  assert.equal(await field.locator(":scope > p").count(), editorParagraphs);
  const finalItem = field.locator("li").last();
  const finalCode = finalItem.locator(".pasted-code-entry > code");
  assert.equal(await finalCode.textContent(), classCode);
  assert.equal(await finalItem.locator("p").count(), 1);
  assert.equal(await chips.count(), 0);
  await finish(classCode, [classLocation]);
  const classChip = chips
    .locator(".code-location")
    .filter({ hasText: "costs.py:4–6" });
  await classChip.waitFor();
  assert(
    await field.evaluate(
      (editor) =>
        editor
          .closest(".composer")
          .querySelector(".code-file-attachments")
          .getBoundingClientRect().bottom <=
        editor.closest(".document-editor-viewport").getBoundingClientRect().top,
    ),
  );
  const listSpacing = await finalCode.evaluate((code) => {
    const item = code.closest("li");
    const firstChar = document.createRange();
    firstChar.setStart(code.firstChild, 0);
    firstChar.setEnd(code.firstChild, 1);
    const first = firstChar.getBoundingClientRect();
    const itemTop = item.getBoundingClientRect().top;
    const last = code.getBoundingClientRect().bottom;
    return {
      leading: first.top - itemTop,
      trailing: item.getBoundingClientRect().bottom - last,
    };
  });
  assert(listSpacing.leading < 9, JSON.stringify(listSpacing));
  assert(listSpacing.trailing < 9, JSON.stringify(listSpacing));
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "list-inline.png") });
  await page.locator("[data-composer-expand]").click();
  await expanded.waitFor();
  assert(await classChip.isVisible());
  assert.equal(await finalCode.textContent(), classCode);
  await classChip.focus();
  const classPreview = page
    .getByRole("tooltip")
    .filter({ hasText: classLocation.path });
  await classPreview.waitFor();
  await page.keyboard.press("Escape");
  await classPreview.waitFor({ state: "detached" });
  assert(await expanded.isVisible());
  await expanded.screenshot({ path: join(output, "list-expanded.png") });
  await page.getByRole("button", { name: "关闭编辑窗口" }).click();
  await page.getByRole("button", { name: /^超长对话性能验证/ }).click();
  await classChip.waitFor({ state: "detached" });
  await page.getByRole("button", { name: /^简短对话/ }).click();
  await classChip.waitFor();
  assert.equal(await finalCode.textContent(), classCode);
  assert.equal(await finalItem.locator("p").count(), 1);
  await classChip.hover();
  await classPreview.waitFor();
  assert.deepEqual(
    await classPreview.locator("code").allTextContents(),
    classLines,
  );
  await classPreview.screenshot({
    path: join(output, "list-matched-preview.png"),
  });
  await page.mouse.move(5, 5);
  await page
    .locator(".composer")
    .screenshot({ path: join(output, "list-restored.png") });
  await finalItem
    .getByRole("button", { name: "移动光标到粘贴代码末尾" })
    .click();
  await page.keyboard.press("Backspace");
  assert.equal(await finalCode.count(), 0);
  assert.equal(await classChip.count(), 0);
  await page.keyboard.press("Control+z");
  assert.equal(await finalCode.textContent(), classCode);
  assert.equal(await classChip.count(), 1);
  await send.click();
  await page.waitForFunction(() =>
    window.historyFixture.requests.some(
      ({ method }) => method === "turn/start",
    ),
  );
  const sent = await sentText();
  assert.match(sent, /```python(?: [^\n]+)?\n/);
  assert(sent.includes(`\n- ${classLocation.path}:${classLocation.line}\n`));
  const sentCode = page
    .locator(".user-text pre")
    .filter({ hasText: classLines[0] });
  await sentCode.waitFor();
  assert.equal(
    (await sentCode.locator("code").textContent()).trimEnd(),
    classCode,
  );
  const sentMessage = sentCode.locator(
    "xpath=ancestor::div[contains(@class, 'user-text')]/..",
  );
  await sentMessage.locator(".code-file-attachment").waitFor();
  assert.doesNotMatch(await sentMessage.textContent(), /粘贴代码已定位/);
  await chips.first().waitFor({ state: "detached", timeout: 3000 });
  assert.equal(await field.textContent(), "");
  await sentCode
    .locator("xpath=ancestor::div[contains(@class, 'user-text')]")
    .screenshot({
      path: join(output, "list-sent.png"),
    });
  await field.focus();
  await page.keyboard.insertText("核对两处代码 ");
  const firstLine = "first = graph[index]";
  const pendingLine = "pending = graph[index + 1]";
  assert(await paste(firstLine));
  await page.keyboard.insertText(" 和 ");
  assert(await paste(pendingLine));
  const submissionCount = () =>
    page.evaluate(
      () =>
        window.historyFixture.requests.filter((r) => r.method === "turn/start")
          .length,
    );
  const countBefore = await submissionCount();
  const matching = page
    .getByRole("status")
    .filter({ hasText: "正在匹配代码文件" });
  await page.evaluate(() => (window.historyFixture.holdSubmission = true));
  await send.click();
  await matching.waitFor();
  assert(await send.isDisabled());
  assert.equal(await submissionCount(), countBefore);
  await page.screenshot({ path: join(output, "send-waiting-for-matches.png") });
  await finish(firstLine, [unique]);
  await chips.first().waitFor();
  assert.equal(await submissionCount(), countBefore);
  await finish(pendingLine, [classLocation]);
  await page.waitForFunction(() => window.historyFixture.finishSubmission);
  const submitted = await page.evaluate(() =>
    window.historyFixture.requests
      .filter((r) => r.method === "turn/start")
      .at(-1)
      .params.input.map((part) => part.text)
      .join("\n"),
  );
  for (const file of [unique, classLocation])
    assert(submitted.includes(`\n- ${file.path}:${file.line}\n`));
  assert.equal(await submissionCount(), countBefore + 1);
  await page.evaluate(() => window.historyFixture.finishSubmission());
  await chips.first().waitFor({ state: "detached", timeout: 3000 });
  assert.equal(await field.textContent(), "");
  await page.screenshot({ path: join(output, "send-cleared.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await field.focus();
  const expires = "expire = graph[0]";
  assert(await paste(expires));
  await field.press("Control+Enter");
  await matching.waitFor();
  assert.equal(await submissionCount(), countBefore + 1);
  await page.screenshot({ path: join(output, "send-waiting-mobile-dark.png") });
  await page.waitForFunction(
    (count) =>
      window.historyFixture.requests.filter((r) => r.method === "turn/start")
        .length === count,
    countBefore + 2,
    { timeout: 4000 },
  );
  await matching.waitFor({ state: "detached" });
  await finish(expires, [unique]);
  assert.equal(await chips.count(), 0);
  await page.waitForFunction(
    () =>
      !document.querySelector(".markdown-composer .ProseMirror").textContent,
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await field.focus();
  const cancelled = "cancelled = graph[1]";
  assert(await paste(cancelled));
  await send.click();
  await matching.waitFor();
  await field.focus();
  await field.press("Control+End");
  await page.keyboard.insertText(" 我先修改这条消息");
  await finish(cancelled, [unique]);
  await matching.waitFor({ state: "detached" });
  assert.equal(await submissionCount(), countBefore + 2);
  assert.match(await field.textContent(), /我先修改这条消息$/);
  await field.press("Control+a");
  await field.press("Backspace");
  await field.focus();
  await page.keyboard.insertText("这条消息正在发送");
  await page.evaluate(() => (window.historyFixture.holdSubmission = true));
  await send.click();
  await page.waitForFunction(() => window.historyFixture.finishSubmission);
  await field.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("，这句是后来输入的");
  await page.evaluate(() => window.historyFixture.finishSubmission());
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="发送消息"]').disabled,
  );
  assert.equal(await field.textContent(), "这条消息正在发送，这句是后来输入的");
  console.log(
    "通过：即时粘贴、整项移除、等待全部匹配后发送、超时后发送正文、发送后清理、保留新输入，以及深浅主题和桌面与窄屏五档缩放。",
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  server.close();
}
