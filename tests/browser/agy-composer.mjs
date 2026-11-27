import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
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
const agy =
  process.env.AGY_EXECUTABLE ||
  execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
const version = execFileSync(agy, ["--version"], { encoding: "utf8" }).trim();
assert.equal(version, "1.5.18");
const output = resolve(process.env.AGY_COMPOSER_OUTPUT || ".cache/t6a/browser");
const root = await mkdtemp(join(tmpdir(), "claudex-agy-composer-"));
const home = join(root, "home");
const cwd = join(root, "workspace");
const bin = join(root, "bin");
const profile = join(home, ".gemini", "antigravity-cli");
const skillDir = join(cwd, ".agents", "skills", "review-checklist");
const skillPath = join(skillDir, "SKILL.md");
const nativeInput = join(root, "acp-input.ndjson");
const nativeOutput = join(root, "acp-output.ndjson");
const skillMarker = "检查附件标题和结论中的术语是否一致。SKILL_FIXTURE_PROOF";
const skillText =
  "---\nname: review-checklist\ndescription: 核对交付文档的术语与结论\n---\n\n" +
  skillMarker;
const textMarker = "隔离附件正文\n第二行用于检查原文。FILE_FIXTURE_PROOF\n";
const binary = Buffer.from([0, 42, 45, 255]);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL3cAAAAASUVORK5CYII=",
  "base64",
);
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
await Promise.all(
  [output, bin, profile, skillDir].map((dir) =>
    mkdir(dir, { recursive: true }),
  ),
);
await writeFile(join(cwd, ".ignore"), "!/demo.js\n");
await writeFile(skillPath, skillText);
await writeFile(
  join(cwd, "demo.js"),
  'function reviewSummary() {\n  return "code location proof";\n}\n',
);
await writeFile(
  join(profile, "settings.json"),
  JSON.stringify({ modelProvider: "gemini", auth: { type: "gemini-api-key" } }),
);
await writeFile(
  join(bin, "agy"),
  `#!/bin/bash
set -o pipefail
if [ "$1" = acp ]; then
  tee -a ${quote(nativeInput)} | ${quote(agy)} "$@" --disable-telemetry | tee -a ${quote(nativeOutput)}
else
  exec ${quote(agy)} "$@" --disable-telemetry
fi
`,
  { mode: 0o700 },
);
await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
Object.assign(process.env, {
  PATH: bin + ":" + process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: root,
  GEMINI_API_KEY: "isolated-agy-composer",
});
delete process.env.DBUS_SESSION_BUS_ADDRESS;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const evidence = {
  version,
  gemini: [],
  layout: [],
  codeLookup: [],
  directory: [],
};
const model = createServer(async (req, res) => {
  if (req.method === "GET") return res.end('{"models":[]}');
  const { contents, systemInstruction } = JSON.parse(
    Buffer.concat(await Array.fromAsync(req)),
  );
  const title = JSON.stringify(systemInstruction || "").includes(
    "conversation title generator",
  );
  const parts = contents.at(-1).parts;
  if (!title) evidence.gemini.push({ parts, contents });
  const text = title ? "文档核对" : "已收到这轮核对要求。";
  const answer = JSON.stringify({
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 16,
      totalTokenCount: 136,
    },
  });
  if (req.url.includes("streamGenerateContent"))
    return res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end("data: " + answer + "\n\n");
  return res.writeHead(200, { "content-type": "application/json" }).end(answer);
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
process.env.GOOGLE_GEMINI_BASE_URL = "http://127.0.0.1:" + model.address().port;
const config = readConfig({
  ...process.env,
  CLAUDEX_WEB_CONFIG_DIR: root,
  DEFAULT_CWD: cwd,
  HOST: "127.0.0.1",
  PORT: "0",
});
const settings = createBackendConfiguration(config);
for (const id of ["codex", "claude"])
  await settings.save({ id, type: id, enabled: false });
const backend = await settings.save({
  id: "agy",
  type: "agy",
  enabled: true,
  proxy: { mode: "off" },
});
const workerSocket = workerLocation(backend.stateDir).socket;
const savedSessions = async () =>
  Object.values(
    JSON.parse(await readFile(join(backend.stateDir, "state.json"), "utf8"))
      .sessions,
  );

async function restartWorker() {
  const worker = await connectIpc(workerSocket);
  const { params: before } = await worker.call("state");
  const closed = once(worker.socket, "close");
  try {
    const deadline = performance.now() + 10_000;
    for (;;) {
      try {
        await worker.call("shutdown");
        break;
      } catch (error) {
        if (
          performance.now() >= deadline ||
          !error.message.includes("仍有执行中的会话或委派任务")
        )
          throw error;
        await delay(150);
      }
    }
    await closed;
  } finally {
    worker.close();
  }
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const peer = await connectIpc(workerSocket).catch(() => null);
    if (peer) {
      try {
        const { params } = await peer.call("state");
        if (params.ready && params.pid !== before.pid) {
          assert.throws(() => process.kill(before.pid, 0), { code: "ESRCH" });
          return { previousPid: before.pid, pid: params.pid };
        }
      } finally {
        peer.close();
      }
    }
    await delay(150);
  }
  throw new Error("隔离 agy Worker 重启超时");
}
const auth = await authenticationFixture(root);
const app = createWebApplication({
  config,
  tls: auth.tls,
  authentication: await createAuthentication(config),
  version: { version: "4.2.3", displayVersion: "4.2.3" },
});
let context, page;
const screenshot = (name) =>
  page.screenshot({
    path: join(output, name + ".png"),
    animations: "disabled",
  });
const packets = async (name) =>
  (await readFile(name, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
try {
  await app.start();
  const url = "https://127.0.0.1:" + app.server.address().port;
  context = await chromium.launchPersistentContext(join(root, "browser"), {
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox", "--no-proxy-server", "--disable-gpu"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 920 },
    colorScheme: "light",
  });
  await context.addCookies([
    {
      name: "__Host-claudex-web-session",
      value: auth.cookie.split("=")[1],
      url,
      httpOnly: true,
    },
  ]);
  page = await context.newPage();
  let measureSwitch = false;
  page.on("websocket", (ws) => {
    const pending = new Set();
    const directory = new Map();
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const packet = JSON.parse(payload);
      if (
        measureSwitch &&
        ["skills/list", "thread/resume"].includes(packet.method) &&
        packet.params?.threadId
      )
        directory.set(packet.id, {
          method: packet.method,
          time: performance.now(),
        });
      if (packet.method !== "lan/workspace/codeLine") return;
      pending.add(packet.id);
      evidence.codeLookup.push(packet);
    });
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const packet = JSON.parse(payload);
      const elapsed = directory.get(packet.id);
      if (elapsed) {
        directory.delete(packet.id);
        evidence.directory.push({
          method: elapsed.method,
          ms: Number((performance.now() - elapsed.time).toFixed(2)),
          commands: packet.result?.commands?.map(({ name }) => name),
          error: packet.error?.message,
        });
      }
      if (pending.delete(packet.id)) evidence.codeLookup.push(packet);
    });
  });
  page.setDefaultTimeout(12_000);
  await page.goto(url);
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  const message = page.getByRole("textbox", { name: "消息", exact: true });
  const commands = page.getByRole("listbox", { name: "快捷命令" });
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  async function draft(text) {
    await message.fill("");
    await message.pressSequentially(text);
  }
  async function sent(count) {
    const replies = page.getByText("已收到这轮核对要求。", { exact: true });
    await replies.nth(count - 1).waitFor();
    await page
      .getByRole("button", { name: "停止任务", exact: true })
      .waitFor({ state: "hidden" });
  }

  async function openSkills() {
    await draft("/skills");
    await commands.getByRole("option", { name: /\/skills/ }).click();
    await page
      .getByRole("dialog", { name: "技能", exact: true })
      .getByPlaceholder("搜索项目技能")
      .waitFor();
  }
  await openSkills();
  const skill = page.getByRole("button", { name: /review-checklist/ });
  await skill.waitFor();
  await screenshot("skills-light");
  await skill.click();
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "交付摘要 #1.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(textMarker),
    },
    { name: "样本.bin", mimeType: "application/octet-stream", buffer: binary },
    { name: "样本.png", mimeType: "image/png", buffer: png },
  ]);
  await page.getByRole("button", { name: "预览 交付摘要 #1.txt" }).click();
  await page
    .getByRole("dialog", { name: "预览 交付摘要 #1.txt" })
    .getByText("FILE_FIXTURE_PROOF", { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "关闭预览" }).click();
  await message.fill("请用项目技能核对这份交付摘要。");
  await message.press("End");
  await message.evaluate((editor) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", '  return "code location proof";\n');
    clipboardData.setData(
      "vscode-editor-data",
      JSON.stringify({
        version: 1,
        mode: "javascript",
        isFromEmptySelection: true,
      }),
    );
    editor.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await page
    .locator(".code-file-attachments")
    .getByText(/demo\.js/)
    .waitFor();
  await screenshot("composer-light");
  await send.click();
  await sent(1);
  const file = page.getByRole("link", { name: "交付摘要 #1.txt", exact: true });
  await file.waitFor();
  await page.reload();
  await sent(1);
  await file.waitFor();
  await page.getByText("review-checklist", { exact: true }).waitFor();
  await file.click();
  await page
    .getByText("FILE_FIXTURE_PROOF", { exact: false })
    .first()
    .waitFor();
  await screenshot("history-file-light");
  await page.getByRole("button", { name: "折叠对话详情" }).click();

  await draft("/grill");
  const command = commands.getByRole("option", { name: /\/grill-me/ });
  await command.waitFor();
  assert.equal(await command.count(), 1);
  await page.emulateMedia({ colorScheme: "dark" });
  await screenshot("command-dark");
  await message.press("Tab");
  await message.press("End");
  await message.pressSequentially(" check the document");
  await send.click();
  await sent(2);

  const [original] = await savedSessions();
  assert(original.nativeId);
  const webThread = await page.evaluate(() =>
    localStorage.getItem("cx-current"),
  );
  const row = page.locator(".thread-row .thread-link");
  assert.equal(await row.count(), 1);
  await page
    .locator(".primary-nav")
    .getByRole("button", { name: /新对话/ })
    .click();
  await page.getByRole("heading", { name: /今天想完成什么/ }).waitFor();
  const beforeRestartInput = (await packets(nativeInput)).length;
  const beforeRestartOutput = (await packets(nativeOutput)).length;
  evidence.restart = await restartWorker();
  measureSwitch = true;
  if (!(await row.isVisible()))
    await page
      .locator("#project-sidebar")
      .getByRole("button", { name: /^workspace/ })
      .click();
  await row.click();
  await sent(2);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("cx-current")),
    webThread,
  );
  await draft("/");
  for (const name of ["grill-me", "learn"]) {
    const option = commands.getByRole("option", {
      name: new RegExp("^/" + name + "(?:\\s|$)"),
    });
    await option.waitFor();
    assert.equal(await option.count(), 1);
  }
  assert.equal(
    await commands
      .getByRole("option", { name: /^\/(plan|goal|review)\b/ })
      .count(),
    0,
  );
  evidence.restart.visibleCommands = (
    await commands.getByRole("option").locator("b").allTextContents()
  ).filter((label) => label.startsWith("/"));
  await commands
    .getByRole("option", { name: /^\/learn\b/ })
    .scrollIntoViewIfNeeded();
  await screenshot("commands-after-restart-dark");
  const beforePlan = evidence.gemini.length;
  await draft("/plan");
  await send.click();
  await page
    .getByText("Antigravity 当前无法使用 /plan。", { exact: true })
    .waitFor();
  assert.equal(evidence.gemini.length, beforePlan);
  await draft("/grill-me restart check");
  await send.click();
  await sent(3);
  measureSwitch = false;
  const afterRestart = (await packets(nativeInput)).slice(beforeRestartInput);
  const resumed = afterRestart.filter(
    ({ method, params }) =>
      method === "session/resume" && params.sessionId === original.nativeId,
  );
  assert.equal(resumed.length, 1, "目录读取与提交复用一次原生续接");
  assert(
    afterRestart.some(
      ({ method, params }) =>
        method === "session/prompt" &&
        params.sessionId === original.nativeId &&
        params.prompt[0]?.text === "/grill-me restart check",
    ),
  );
  assert(
    evidence.directory.some(
      ({ method, commands }) =>
        method === "skills/list" && commands?.includes("grill-me"),
    ),
  );
  evidence.restart.resumes = resumed.length;
  evidence.restart.resumeCommandUpdates = (await packets(nativeOutput))
    .slice(beforeRestartOutput)
    .filter(
      ({ params }) =>
        params?.sessionId === original.nativeId &&
        params.update?.sessionUpdate === "available_commands_update",
    )
    .map(({ params }) =>
      params.update.availableCommands.map(({ name }) => name),
    );
  await openSkills();
  await skill.waitFor();
  await screenshot("skills-dark");
  await page.getByRole("button", { name: "关闭窗口" }).click();

  await draft("/review-checklist");
  await commands.getByRole("option", { name: /review-checklist/ }).click();
  await rm(skillPath);
  await message.fill("保留失败草稿");
  const modelRequests = evidence.gemini.length;
  await send.click();
  await page
    .getByText(/已移动、删除或改名/)
    .first()
    .waitFor();
  assert.equal(await message.textContent(), "保留失败草稿");
  assert.equal(evidence.gemini.length, modelRequests);
  await screenshot("missing-skill-dark");
  await page.getByRole("button", { name: "移除 review-checklist" }).click();
  await message.fill("");
  await openSkills();
  await page.getByText("当前项目没有可用技能", { exact: true }).waitFor();
  await screenshot("skills-empty-dark");
  await page.getByRole("button", { name: "关闭窗口" }).click();
  await writeFile(skillPath, skillText);

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
        await sent(3);
        await draft("/grill");
        await command.waitFor();
        const { left, right, top, bottom } = await command
          .boundingBox()
          .then(({ x, y, width, height }) => ({
            left: x,
            right: x + width,
            top: y,
            bottom: y + height,
          }));
        const metrics = await page.evaluate(() => ({
          dpr: devicePixelRatio,
          width: innerWidth,
          height: innerHeight,
          scroll: document.documentElement.scrollWidth,
        }));
        assert(Math.abs(metrics.dpr - scale) < 0.02, JSON.stringify(metrics));
        assert(
          Math.abs(metrics.width - width / scale) <= 1,
          JSON.stringify(metrics),
        );
        assert(metrics.scroll <= metrics.width + 1, JSON.stringify(metrics));
        assert(
          left >= 0 &&
            right <= metrics.width + 1 &&
            top >= 0 &&
            bottom <= metrics.height + 1,
        );
        assert(
          await command.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return [0.25, 0.5, 0.9].every((ratio) =>
              element.contains(
                document.elementFromPoint(
                  rect.left + rect.width * ratio,
                  rect.top + rect.height / 2,
                ),
              ),
            );
          }),
          "命令选项可点击区域被其它控件遮盖",
        );
        evidence.layout.push({ width, colorScheme, scale, ...metrics });
        if (width === 390 && (scale === 1 || scale === 2))
          await screenshot(`mobile-${colorScheme}-${scale * 100}`);
        await message.press("Escape");
        await message.fill("");
        if (width === 390 && scale === 2) {
          await openSkills();
          await skill.waitFor();
          const dialog = page.getByRole("dialog", {
            name: "技能",
            exact: true,
          });
          const bounds = await dialog.boundingBox();
          assert(bounds.x >= 0 && bounds.x + bounds.width <= metrics.width + 1);
          await screenshot(`skills-mobile-${colorScheme}-200`);
          await page.getByRole("button", { name: "关闭窗口" }).click();
        }
      }
    }
  }
  await zoom.selectOption("1");
  await preferences.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "显示侧栏", exact: true }).click();
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector("#project-sidebar")
        .contains(document.activeElement),
  );

  const input = await packets(nativeInput);
  const updates = await packets(nativeOutput);
  evidence.acp = input
    .filter(({ method }) => method === "session/prompt")
    .map(({ params }) => params.prompt);
  evidence.catalogues = updates
    .filter(
      ({ params }) =>
        params?.update?.sessionUpdate === "available_commands_update",
    )
    .map(({ params }) =>
      params.update.availableCommands.map(({ name }) => name),
    );
  assert(
    evidence.catalogues.some(
      (names) => names.includes("grill-me") && names.includes("learn"),
    ),
  );
  assert.equal(evidence.acp.length, 3);
  const [resources, native, restarted] = evidence.acp;
  assert(
    resources.some(
      ({ type, text }) =>
        type === "text" &&
        text.includes("demo.js:2") &&
        text.includes("code location proof"),
    ),
  );
  assert(
    resources.some(
      ({ type, resource }) =>
        type === "resource" &&
        resource.uri.endsWith("SKILL.md") &&
        resource.text.includes(skillMarker),
    ),
  );
  assert(
    resources.some(
      ({ type, resource }) =>
        type === "resource" &&
        resource.uri.endsWith("%20%231.txt") &&
        resource.text === textMarker,
    ),
  );
  assert(
    resources.some(
      ({ type, resource }) =>
        type === "resource" &&
        resource.text.includes(binary.toString("base64")),
    ),
  );
  assert(
    resources.some(
      ({ type, data }) => type === "image" && data === png.toString("base64"),
    ),
  );
  assert.equal(native[0].text, "/grill-me check the document");
  assert.equal(restarted[0].text, "/grill-me restart check");
  assert(
    evidence.gemini.some(
      ({ parts }) =>
        parts.some(
          ({ text }) =>
            text?.includes(skillMarker) &&
            text.includes(textMarker) &&
            text.includes("demo.js:2") &&
            text.includes(binary.toString("base64")),
        ) &&
        parts.some(
          ({ inlineData }) => inlineData?.data === png.toString("base64"),
        ),
    ),
  );
  assert(
    evidence.gemini.some(({ parts }) =>
      parts.some(
        ({ text }) =>
          text?.includes("<GRILL_ME>") && text.includes("check the document"),
      ),
    ),
  );
  assert(
    evidence.gemini
      .at(-1)
      .contents.some(
        ({ role, parts }) =>
          role === "user" &&
          parts.some(
            ({ text }) =>
              text?.includes("/grill-me restart check") &&
              text.includes("<GRILL_ME>"),
          ),
      ),
  );
  console.log(
    "agy 1.5.18 · ACP skills, slash expansion after Worker restart, resources, recovery, and 20 browser layout states passed.",
  );
  console.log(
    JSON.stringify({
      restart: evidence.restart,
      directory: evidence.directory,
    }),
  );
} catch (error) {
  await screenshot("failure").catch(() => {});
  throw error;
} finally {
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  await context?.close();
  const peer = await connectIpc(workerSocket).catch(() => null);
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
    model.close();
    await rm(root, { recursive: true, force: true });
  }
}
