import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:https";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import native from "node-datachannel";
import { createWebApplication } from "../../server/src/application.mjs";
import { createAuthentication } from "../../server/src/auth.mjs";
import { readConfig } from "../../server/src/config.mjs";
import { authenticationFixture, httpsFetch } from "../helpers/auth.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, ".cache/p2p-auth-browser");
const directory = await mkdtemp(join(tmpdir(), "claudex-p2p-browser-"));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const { tls, cookie, pamtester } = await authenticationFixture(directory);
let signalingPort;
const ingress = createServer(tls, (incoming, outgoing) => {
  const upstream = request(
    {
      hostname: "127.0.0.1",
      port: signalingPort,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => outgoing.destroy());
  incoming.pipe(upstream);
});
ingress.listen(0, "127.0.0.1");
await once(ingress, "listening");
const origin = `https://127.0.0.1:${ingress.address().port}`;
const backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(backend, "listening");
const replies = {
  "account/read": { account: null },
  "model/list": { data: [] },
  "thread/list": { data: [], nextCursor: null },
  "skills/list": { data: [] },
};
backend.on("connection", (socket) => {
  socket.on("message", (bytes) => {
    const { method, id } = JSON.parse(bytes);
    if (id !== undefined)
      socket.send(JSON.stringify({ id, result: replies[method] || {} }));
  });
});
const config = readConfig({
  HOST: "127.0.0.1",
  PORT: "0",
  CODEX_HOME: join(directory, "codex"),
  CLAUDE_CONFIG_DIR: join(directory, "claude"),
  CLAUDEX_WEB_CONFIG_DIR: directory,
  DEFAULT_CWD: directory,
  STATIC_DIR: process.env.UI_BUILD_DIR || join(root, "client/dist"),
  AUTH_PAMTESTER: pamtester,
  CODEX_APP_SERVER_URL: `ws://127.0.0.1:${backend.address().port}`,
});
config.translationModelDir = join(directory, "translation");
const authentication = await createAuthentication(config);
const app = createWebApplication({
  config,
  tls,
  authentication,
  version: { displayVersion: "fixture", version: "0.0.0" },
  async runP2pTunnel({ port, signal, onOrigin, onState }) {
    signalingPort = port;
    await onOrigin(origin);
    onState("online");
    await once(signal, "abort");
  },
});

let context;
try {
  await app.start();
  const local = `https://127.0.0.1:${app.server.address().port}`;
  const localRequest = httpsFetch(tls.cert, cookie);
  async function manage(action, input) {
    const response = await localRequest(local + "/api/p2p/" + action, {
      method: "POST",
      ...(input && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  await manage("enable");
  const deadline = AbortSignal.timeout(10000);
  while (
    (await (await localRequest(local + "/api/p2p")).json()).state !== "online"
  )
    await wait(30, undefined, { signal: deadline });
  const { created } = await manage("create", { label: "浏览器回归" });
  const note = join(directory, "p2p-auth-fixture.txt");
  await writeFile(note, "登录后才能读取");
  const publicKey = new X509Certificate(tls.cert).publicKey.export({
    type: "spki",
    format: "der",
  });
  const certificatePin = createHash("sha256")
    .update(publicKey)
    .digest("base64");
  context = await chromium.launchPersistentContext(join(directory, "profile"), {
    executablePath: process.env.CHROME_PATH,
    viewport: { width: 1280, height: 900 },
    headless: true,
    args: [
      "--no-sandbox",
      "--no-proxy-server",
      "--disable-gpu",
      "--ignore-certificate-errors-spki-list=" + certificatePin,
    ],
  });
  const page = await context.newPage();
  const publicRequests = [];
  page.on("request", (item) =>
    publicRequests.push(new URL(item.url()).pathname),
  );
  const login = page.getByRole("heading", { name: "登录远程工作空间" });
  const username = page.getByLabel("用户名", { exact: true });
  const password = page.getByLabel("密码", { exact: true });
  const submit = page.getByRole("button", { name: "登录", exact: true });
  const composer = page.locator(".composer .ProseMirror");
  await page.goto(origin + "/p2p");
  await page.getByText("请打开包含授权信息的完整 P2P 链接。").waitFor();
  await page.goto(created.url);
  await login.waitFor();
  assert.equal(await composer.count(), 0);
  assert.equal(
    await username.evaluate((el) => el === document.activeElement),
    true,
  );
  const readNote = () =>
    page.evaluate(async (path) => {
      const response = await fetch(
        "/api/files?" + new URLSearchParams({ path }),
      );
      return { status: response.status, body: await response.text() };
    }, note);
  assert.deepEqual(await readNote(), { status: 401, body: "" });
  await mkdir(output, { recursive: true });
  await captureLogin(context, page, login, username, submit);
  await username.fill(userInfo().username);
  await password.fill("wrong-password");
  await submit.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "用户名或密码错误" })
    .waitFor();
  assert.equal(await password.inputValue(), "");
  await page.screenshot({ path: join(output, "incorrect-password.png") });
  await password.fill("fixture-password");
  await submit.click();
  await composer.waitFor();
  assert.deepEqual(await readNote(), { status: 200, body: "登录后才能读取" });
  await page.reload();
  await composer.waitFor();
  const otherTab = await context.newPage();
  await otherTab.goto(created.url);
  await otherTab.getByRole("heading", { name: "登录远程工作空间" }).waitFor();
  await otherTab.close();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("连接与登录", { exact: true }).click();
  await page
    .getByText("已登录：" + userInfo().username + " · P2P 直连")
    .waitFor();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await login.waitFor();
  assert.deepEqual(await readNote(), { status: 401, body: "" });
  await page.reload();
  await login.waitFor();
  await username.fill(userInfo().username);
  await password.fill("fixture-password");
  await submit.click();
  await composer.waitFor();
  await manage("revoke", { id: created.id });
  await page
    .getByRole("alert")
    .filter({ hasText: "链接已失效或已被撤销" })
    .waitFor();
  assert.equal(await composer.count(), 0);
  assert.equal(
    publicRequests.some((path) => path.startsWith("/api/auth/")),
    false,
  );
  assert.deepEqual(await context.cookies(origin), []);
  console.log("P2P 浏览器登录、文件权限、刷新、新标签页、退出和撤销通过。");
} finally {
  await context?.close();
  await app.close();
  await new Promise((resolve) => ingress.close(resolve));
  await new Promise((resolve) => backend.close(resolve));
  native.cleanup();
  await rm(directory, { recursive: true, force: true });
}

async function captureLogin(context, page, login, username, submit) {
  const settings = await context.newPage();
  await settings.goto("chrome://settings/appearance");
  const zoom = settings.locator("#zoomLevel");
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.reload();
          await login.waitFor();
          const metrics = await page.evaluate(() => ({
            width: innerWidth,
            dpr: devicePixelRatio,
            scrollWidth: document.documentElement.scrollWidth,
          }));
          assert.ok(Math.abs(metrics.dpr - scale) < 0.02);
          assert.ok(Math.abs(metrics.width - width / scale) <= 1);
          assert.ok(metrics.scrollWidth <= metrics.width);
          await username.scrollIntoViewIfNeeded();
          const box = await submit.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= metrics.width);
          if (
            (width === 1280 && theme === "light" && scale === 1) ||
            (width === 390 && theme === "dark" && scale === 1)
          )
            await page.screenshot({
              path: join(output, `login-${width}-${theme}.png`),
            });
        }
      }
    }
  } finally {
    await zoom.selectOption("1");
    await settings.close();
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await login.waitFor();
  }
}
