import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { plansFixture } from "../fixtures/plans.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.BROWSER_BEFORE === "1";
const build = join(
  root,
  before ? ".cache/mermaid-size-before/dist" : "client/dist",
);
const output = join(
  root,
  ".cache/mermaid-size-browser",
  before ? "before" : "after",
);
await mkdir(output, { recursive: true });
const markdown = [
  "当前实现先累积三维占据地图，再从机器人附近传播地形参考，最终生成单层高程图。",
  "```mermaid",
  "flowchart TB",
  "A[前后雷达点云] --> C[按点云时间戳查询 TF<br/>转换到地图坐标系]",
  "B[FastLIO 位姿与传感器外参] --> C",
  "C --> D[构造传感器原点到回波的射线<br/>检查有限坐标并裁剪到滚动窗口]",
  "D --> E[OHM 三维占据融合<br/>射线路径更新空闲证据<br/>回波端点更新占据证据]",
  "E --> F[同步体素层<br/>清理窗口外区域]",
  "F --> G[获取占据层与体素均值快照]",
  "```",
  "图表之后继续阅读正文。",
  "```mermaid",
  "flowchart LR",
  "A[输入] --> B[处理] --> C[输出]",
  "```",
  "```mermaid",
  "sequenceDiagram",
  "用户->>服务: 提交任务",
  "服务-->>用户: 返回结果",
  "```",
  "[diagram.md](./diagram.md)",
].join("\n\n");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
const server = http.createServer(async (request, response) => {
  if (serveDemoSession(request, response)) return;
  try {
    const path = new URL(request.url, "http://fixture").pathname;
    const content = await readFile(
      join(build, path === "/" ? "index.html" : path),
    );
    response
      .writeHead(200, { "Content-Type": mime[extname(path)] || "text/html" })
      .end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const profile = await mkdtemp(join(tmpdir(), "claudex-mermaid-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"],
});
const records = [];
async function verifyExpansion(block) {
  const diagram = block.getByRole("region", { name: "Mermaid 图表" });
  const expand = block.getByRole("button", { name: "展开图表", exact: true });
  assert.equal(await expand.innerText(), "");
  assert.equal(await expand.locator("svg.lucide-maximize").count(), 1);
  const originalZoom = await block
    .getByRole("button", { name: "重置图表缩放" })
    .innerText();
  await expand.click();
  const collapse = block.getByRole("button", { name: "收起图表", exact: true });
  assert.equal(await collapse.locator("svg.lucide-minimize").count(), 1);
  assert.equal(await collapse.getAttribute("aria-expanded"), "true");
  assert.equal(
    await collapse.getAttribute("aria-controls"),
    await diagram.getAttribute("id"),
  );
  assert.equal(
    await diagram.evaluate((element) => getComputedStyle(element).maxHeight),
    "none",
  );
  assert.equal(
    await diagram.evaluate(
      (element) => element.scrollHeight <= element.clientHeight + 1,
    ),
    true,
  );
  assert.equal(
    await block.getByRole("button", { name: "重置图表缩放" }).innerText(),
    originalZoom,
  );
  await collapse.click();
  assert.equal(
    await block
      .getByRole("button", { name: "展开图表", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.notEqual(
    await diagram.evaluate((element) => getComputedStyle(element).maxHeight),
    "none",
  );
}
try {
  await context.addInitScript((text) => {
    sessionStorage.setItem(
      "plan-turns",
      JSON.stringify([
        {
          id: "diagram-turn",
          status: "completed",
          items: [
            {
              id: "diagram-answer",
              type: "agentMessage",
              phase: "final_answer",
              text,
            },
          ],
        },
      ]),
    );
  }, markdown);
  await context.addInitScript(plansFixture);
  await context.addInitScript((text) => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (raw) {
      const request = JSON.parse(raw);
      if (request.method === "fs/readFile") {
        setTimeout(
          () =>
            this.onmessage({
              data: JSON.stringify({
                id: request.id,
                result: {
                  dataBase64: btoa(unescape(encodeURIComponent(text))),
                },
              }),
            }),
          0,
        );
      } else send.call(this, raw);
    };
  }, markdown);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const settings = await context.newPage();
  await settings.goto("chrome://settings/appearance");
  const zoom = settings.locator("#zoomLevel");
  await zoom.waitFor();
  for (const width of before ? [1440] : [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of before ? ["light"] : ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const scale of before ? [1] : [0.8, 1, 1.25, 1.5, 2]) {
        console.log("消息区", width, theme, scale);
        await zoom.selectOption(String(scale));
        await page.reload();
        await page
          .locator(".assistant-message .mermaid-diagram > svg")
          .nth(2)
          .waitFor();
        const diagrams = page.locator(".assistant-message .mermaid-diagram");
        const metrics = await diagrams.evaluateAll((elements) =>
          elements.map((element) => {
            const svg = element.querySelector("svg");
            const label = svg.querySelector(".nodeLabel, .messageText");
            const rect = svg.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              viewBox: svg.getAttribute("viewBox"),
              font: getComputedStyle(label).fontSize,
              paragraphMargin:
                svg.querySelector("p") &&
                getComputedStyle(svg.querySelector("p")).margin,
              container: element.clientWidth,
            };
          }),
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        if (!before) {
          assert(metrics.every((diagram) => diagram.font === "13px"));
          assert(
            metrics.every((diagram) => diagram.width <= diagram.container),
          );
          assert.equal(
            await diagrams
              .first()
              .evaluate(
                (element) => element.clientHeight <= innerHeight * 0.7 + 1,
              ),
            true,
          );
          await verifyExpansion(
            page.locator(".assistant-message .mermaid-block").first(),
          );
        }
        records.push({
          width,
          theme,
          scale,
          dpr: await page.evaluate(() => devicePixelRatio),
          metrics,
        });
        if (scale === 1) {
          await page.locator(".assistant-message").screenshot({
            path: join(output, `${width}-${theme}-message.png`),
          });
          await diagrams.first().scrollIntoViewIfNeeded();
          await page.screenshot({
            path: join(output, `${width}-${theme}.png`),
          });
        }
      }
    }
  }
  await zoom.selectOption("1");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.locator(".mermaid-diagram svg").nth(2).waitFor();
  const toggle = page
    .getByRole("button", { name: "查看源码", exact: true })
    .first();
  await toggle.click();
  assert.match(
    await page.locator(".mermaid-block pre").first().innerText(),
    /flowchart TB/,
  );
  await page.getByRole("button", { name: "查看图表", exact: true }).click();
  if (!before) {
    const block = page.locator(".assistant-message .mermaid-block").first();
    const diagram = block.getByRole("region", { name: "Mermaid 图表" });
    const size = () =>
      diagram
        .locator("svg")
        .evaluate((element) => element.getBoundingClientRect().width);
    const originalWidth = await size();
    assert.equal(
      await block.getByRole("combobox", { name: "图表方向" }).inputValue(),
      "TB",
    );
    assert.deepEqual(
      await block
        .locator("select[aria-label='图表方向'] option")
        .allTextContents(),
      ["横向", "纵向"],
    );
    await block.getByRole("button", { name: "展开图表", exact: true }).click();
    await block.screenshot({ path: join(output, "expanded.png") });
    await block.getByRole("button", { name: "放大图表", exact: true }).click();
    assert(Math.abs((await size()) - originalWidth * 1.25) < 1);
    await diagram.focus();
    await page.keyboard.press("+");
    assert.equal(
      await block.getByRole("button", { name: "重置图表缩放" }).innerText(),
      "150%",
    );
    await page.keyboard.press("0");
    assert(Math.abs((await size()) - originalWidth) < 1);
    await diagram.hover();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForFunction(
      () =>
        document.querySelector(
          ".assistant-message .mermaid-zoom button[title='重置图表缩放']",
        ).textContent === "125%",
    );
    assert.equal(
      await block.getByRole("button", { name: "重置图表缩放" }).innerText(),
      "125%",
    );
    await block.getByRole("combobox", { name: "图表方向" }).selectOption("LR");
    await page.waitForFunction(() => {
      const svg = document.querySelector(
        ".assistant-message .mermaid-diagram svg",
      );
      return svg && svg.viewBox.baseVal.width > svg.viewBox.baseVal.height;
    });
    assert.equal(
      await block
        .getByRole("button", { name: "收起图表", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      await block.getByRole("button", { name: "重置图表缩放" }).innerText(),
      "100%",
    );
    await block.screenshot({ path: join(output, "horizontal.png") });
    await block.getByRole("button", { name: "放大图表", exact: true }).click();
    await block.screenshot({ path: join(output, "horizontal-zoom.png") });
    await block.getByRole("button", { name: "查看源码", exact: true }).click();
    assert.match(await block.locator("pre").innerText(), /flowchart TB/);
    await block.getByRole("button", { name: "查看图表", exact: true }).click();
    assert.equal(
      await block
        .getByRole("button", { name: "收起图表", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    await block.getByRole("combobox", { name: "图表方向" }).selectOption("TB");
    await page.waitForFunction(() => {
      const svg = document.querySelector(
        ".assistant-message .mermaid-diagram svg",
      );
      return svg && svg.viewBox.baseVal.height > svg.viewBox.baseVal.width;
    });
    await block.getByRole("button", { name: "收起图表", exact: true }).click();
  }
  await page.getByRole("link", { name: "diagram.md", exact: true }).click();
  await page
    .locator(".file-markdown-preview .mermaid-diagram svg")
    .nth(2)
    .waitFor();
  await page.screenshot({ path: join(output, "file-preview.png") });
  if (!before) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        await page
          .locator(".file-markdown-preview .mermaid-diagram svg")
          .nth(2)
          .waitFor();
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          console.log("文件预览", width, theme, scale);
          await zoom.selectOption(String(scale));
          await page.waitForFunction(
            (scale) => Math.abs(devicePixelRatio - scale) < 0.01,
            scale,
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
          await verifyExpansion(
            page.locator(".file-markdown-preview .mermaid-block").first(),
          );
        }
      }
    }
    await zoom.selectOption("1");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const block = page.locator(".file-markdown-preview .mermaid-block").first();
    await block.getByRole("combobox", { name: "图表方向" }).selectOption("LR");
    await page.waitForFunction(() => {
      const svg = document.querySelector(
        ".file-markdown-preview .mermaid-diagram svg",
      );
      return svg && svg.viewBox.baseVal.width > svg.viewBox.baseVal.height;
    });
    await block.getByRole("button", { name: "放大图表", exact: true }).click();
    assert.equal(
      await block.getByRole("button", { name: "重置图表缩放" }).innerText(),
      "125%",
    );
    await page.screenshot({ path: join(output, "file-horizontal.png") });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      {
        records,
        errors,
        build: JSON.parse(
          await readFile(
            join(
              root,
              before
                ? ".cache/mermaid-size-before/build-info.json"
                : "build-info.json",
            ),
            "utf8",
          ),
        ),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(records[0]));
  console.log(
    "PASS Mermaid 真实渲染、展开收起与完整高度、方向切换、按钮/键盘/滚轮缩放、原始源码、消息与文件预览、主题、实际浏览器缩放及窄屏",
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  server.close();
}
