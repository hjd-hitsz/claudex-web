import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { serveDemoSession } from "../helpers/browser-session.mjs";
import { backendSwitchPerformanceFixture } from "../fixtures/backend-switch-performance.mjs";
const before = process.env.BROWSER_BEFORE === "1";
const output = join(
  process.cwd(),
  ".cache/backend-switch-performance",
  before ? "before" : "after",
);
const build = before
  ? join(output, "dist")
  : join(process.cwd(), "client/dist");
await mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  if (serveDemoSession(req, res)) return;
  try {
    const path = new URL(req.url, "http://fixture").pathname;
    let content = await readFile(
      join(build, path === "/" ? "index.html" : path),
    );
    if (path === "/")
      content = content
        .toString()
        .replace(
          "<head>",
          `<head><script>(${backendSwitchPerformanceFixture.toString()})()</script>`,
        );
    res
      .writeHead(200, {
        "Content-Type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[extname(path)] || "text/html",
      })
      .end(content);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: ["--disable-gpu", "--no-proxy-server"],
});
const samples = [],
  errors = [];
const quantile = (values, p) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(".composer .ProseMirror").waitFor();
  const rows = page.locator(".sidebar .thread-row");
  await rows.first().waitFor();
  const more = page.getByRole("button", { name: /^查看更多/ });
  if (await more.count()) await more.click();
  async function open(backend, n, measure = false) {
    const title = `${backend} 对话 ${n}`;
    const id = backend === "codex" ? `codex-${n}` : `backend:${backend}:${n}`;
    const button = page.getByRole("button", { name: new RegExp(`^${title}`) });
    await button.evaluate(
      (node, { id, measure }) => {
        window.switchFixture.begin(id);
        if (measure) window.switchFixture.slow = true;
        node.click();
      },
      { id, measure },
    );
    await page.waitForFunction(
      (id) =>
        window.switchFixture.pending?.id === id &&
        window.switchFixture.pending.firstPaint !== null,
      id,
    );
    await page
      .locator('.composer .ProseMirror[contenteditable="true"]')
      .waitFor();
    return page.evaluate(() => {
      const state = window.switchFixture,
        p = state.pending;
      const end = performance.now();
      return {
        firstPaintMs: p.firstPaint,
        readyMs: end - p.started,
        longestTaskMs: Math.max(
          0,
          ...state.longTasks
            .filter((t) => t.start >= p.started && t.start < end)
            .map((t) => t.duration),
        ),
        requests: state.requests
          .filter((r) => r.start >= p.started)
          .map((r) => ({
            method: r.method,
            backendId: r.params.backendId,
            startMs: r.start - p.started,
            elapsedMs: r.end - r.start,
          })),
      };
    });
  }
  const backends = ["codex", "claude", "opencode"];
  for (let round = 0; round < (before ? 3 : 6); round++) {
    for (const from of backends)
      for (const to of backends) {
        await open(from, 0);
        const measured = await open(to, 1, true);
        samples.push({
          from,
          to,
          visit: round === 0 ? "first" : "repeat",
          ...measured,
        });
        console.log(
          JSON.stringify({
            from,
            to,
            round,
            firstPaintMs: measured.firstPaintMs,
            readyMs: measured.readyMs,
          }),
        );
      }
  }
  await page.screenshot({
    path: join(output, "conversation.png"),
    animations: "disabled",
  });
  const summary = Object.fromEntries(
    [false, true].map((cross) => {
      const items = samples.filter((s) => (s.from !== s.to) === cross);
      return [
        cross ? "crossBackend" : "sameBackend",
        {
          count: items.length,
          medianMs: quantile(
            items.map((s) => s.firstPaintMs),
            0.5,
          ),
          p95Ms: quantile(
            items.map((s) => s.firstPaintMs),
            0.95,
          ),
          readyP95Ms: quantile(
            items.map((s) => s.readyMs),
            0.95,
          ),
          longestTaskMs: Math.max(...items.map((s) => s.longestTaskMs)),
        },
      ];
    }),
  );
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      { metadataDelayMs: 1800, summary, samples, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(summary, null, 2));
  assert.deepEqual(errors, []);
  if (!before) {
    assert.ok(summary.crossBackend.p95Ms < 250, "跨后端首屏应在 250 ms 内出现");
    assert.ok(
      summary.crossBackend.p95Ms <= summary.sameBackend.p95Ms + 50,
      "跨后端切换的额外成本不得超过 50 ms 浏览器调度窗口",
    );
    assert.ok(
      summary.crossBackend.readyP95Ms < 300,
      "输入区恢复不等待辅助请求",
    );
  }
} finally {
  await browser.close();
  server.close();
}
