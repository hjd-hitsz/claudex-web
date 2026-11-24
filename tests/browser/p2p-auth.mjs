import assert from "node:assert/strict";
import { settingsPage } from "../helpers/settings-navigation.mjs";
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
import {
  authenticationFixture,
  enrollFixtureTotp,
  fixtureTotpCode,
  httpsFetch,
} from "../helpers/auth.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, ".cache/p2p-auth-browser");
const directory = await mkdtemp(join(tmpdir(), "claudex-p2p-browser-"));
const { chromium, devices } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE)
);
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
  const { created: otherLink } = await manage("create", {
    label: "单独授权",
  });
  const note = join(directory, "p2p-auth-fixture.txt");
  await writeFile(note, "登录后才能读取");
  const publicKey = new X509Certificate(tls.cert).publicKey.export({
    type: "spki",
    format: "der",
  });
  const certificatePin = createHash("sha256")
    .update(publicKey)
    .digest("base64");
  const publicRequests = [];
  async function openBrowser(options) {
    const browser = await chromium.launchPersistentContext(
      join(directory, "profile"),
      {
        executablePath: process.env.CHROME_PATH,
        headless: true,
        args: [
          "--no-sandbox",
          "--no-proxy-server",
          "--disable-gpu",
          "--ignore-certificate-errors-spki-list=" + certificatePin,
        ],
        ...options,
      },
    );
    browser.on("request", (item) => {
      if (new URL(item.url()).origin === origin)
        publicRequests.push({ method: item.method(), url: item.url() });
    });
    return browser;
  }
  context = await openBrowser({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const login = page.getByRole("heading", { name: "登录远程工作空间" });
  const username = page.getByLabel("用户名", { exact: true });
  const password = page.getByLabel("密码", { exact: true });
  const submit = page.getByRole("button", { name: "登录", exact: true });
  const composer = page.locator(".composer .ProseMirror");
  await page.goto(origin + "/p2p");
  await page.getByText("请打开包含授权信息的完整 P2P 链接。").waitFor();
  await mkdir(output, { recursive: true });
  await verifyConnectionRecovery(
    page,
    created.url,
    login,
    httpsFetch(tls.cert),
  );
  await login.waitFor();
  assert.equal(await composer.count(), 0);
  assert.equal(
    await page.locator("#login-form").getAttribute("method"),
    "post",
  );
  assert.equal(
    await username.evaluate((el) => el === document.activeElement),
    true,
  );
  const readNote = (target = page) =>
    target.evaluate(async (path) => {
      const response = await fetch(
        "/api/files?" + new URLSearchParams({ path }),
      );
      return { status: response.status, body: await response.text() };
    }, note);
  assert.deepEqual(await readNote(), { status: 401, body: "" });
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
  const code = page.getByLabel("六位动态码", { exact: true });
  const authenticator = page.getByLabel("验证器名称", { exact: true });
  const verify = page.getByRole("button", { name: "验证并登录" });
  await code.waitFor();
  assert.equal(
    await code.evaluate((input) => input === document.activeElement),
    true,
  );
  assert.deepEqual(await readNote(), { status: 401, body: "" });
  await enrollFixtureTotp(directory, "测试手机");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await authenticator.waitFor();
  await captureTotp(context, page, code, verify);
  await code.fill(fixtureTotpCode(directory));
  await verify.click();
  await composer.waitFor();
  assert.deepEqual(await readNote(), { status: 200, body: "登录后才能读取" });
  await page.evaluate(() => sessionStorage.removeItem("cx-p2p-link"));
  assert.equal(new URL(page.url()).hash, "");
  await page.reload();
  await composer.waitFor();
  assert.deepEqual(await readNote(), { status: 200, body: "登录后才能读取" });
  await page.screenshot({ path: join(output, "restored-tab-workspace.png") });
  const devtools = await context.newCDPSession(page);
  const loaded = page.waitForEvent("load");
  await devtools.send("Page.reload", { ignoreCache: true });
  await loaded;
  await devtools.detach();
  await composer.waitFor();
  assert.deepEqual(await readNote(), { status: 200, body: "登录后才能读取" });
  await page.screenshot({ path: join(output, "hard-refresh-recovered.png") });
  await page.evaluate((link) => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("cx-p2p-login:"),
    );
    const { token } = JSON.parse(localStorage.getItem(key));
    sessionStorage.setItem("cx-p2p-login", JSON.stringify({ link, token }));
    localStorage.removeItem(key);
  }, new URL(created.url).hash.slice(1));
  await page.reload();
  await composer.waitFor();
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("cx-p2p-login")),
    null,
  );
  let otherTab = await context.newPage();
  await otherTab.goto(otherLink.url);
  await otherTab.getByRole("heading", { name: "登录远程工作空间" }).waitFor();
  assert.deepEqual(await readNote(otherTab), { status: 401, body: "" });
  await otherTab.goto(created.url);
  await otherTab.locator(".composer .ProseMirror").waitFor({ timeout: 15000 });
  await otherTab.reload();
  await otherTab.locator(".composer .ProseMirror").waitFor();
  await otherTab.close();
  otherTab = await context.newPage();
  await otherTab.goto(created.url);
  await otherTab.locator(".composer .ProseMirror").waitFor();
  assert.deepEqual(await readNote(otherTab), {
    status: 200,
    body: "登录后才能读取",
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settingsPage(page, "连接与登录").click();
  await page
    .getByText("已登录：" + userInfo().username + " · P2P 直连")
    .waitFor();
  await page.getByText("双重验证（2FA）已启用", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("region", { name: "局域网 HTTPS 证书" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("region", { name: "P2P 远程访问" }).count(),
    0,
  );
  await page.getByText("双重验证使用方法", { exact: true }).click();
  await page.getByText("claudex-web auth disable", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "totp-settings-p2p.png") });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await login.waitFor();
  await otherTab.getByRole("heading", { name: "登录远程工作空间" }).waitFor();
  await otherTab.close();
  assert.deepEqual(await readNote(), { status: 401, body: "" });
  await page.reload();
  await login.waitFor();
  await username.fill(userInfo().username);
  await password.fill("fixture-password");
  await submit.click();
  await authenticator.fill("测试手机");
  await code.fill(fixtureTotpCode(directory, 0, "测试手机"));
  await verify.click();
  await composer.waitFor();
  await context.close();
  context = await openBrowser(devices["Pixel 7"]);
  const reopened = await context.newPage();
  await reopened.goto(created.url);
  await reopened.locator(".composer .ProseMirror").waitFor();
  assert.deepEqual(await readNote(reopened), {
    status: 200,
    body: "登录后才能读取",
  });
  await reopened.screenshot({ path: join(output, "mobile-reopened.png") });
  await manage("revoke", { id: created.id });
  await reopened
    .getByRole("alert")
    .filter({ hasText: "链接已失效或已被撤销" })
    .waitFor();
  assert.equal(await reopened.locator(".composer .ProseMirror").count(), 0);
  assert.equal(
    await reopened.evaluate(() => history.state?.["cx-p2p-link"] ?? null),
    null,
  );
  assert.equal(
    publicRequests.some(({ method, url }) => {
      const { pathname } = new URL(url);
      return (
        pathname.startsWith("/api/auth/") ||
        (method === "POST" && pathname !== "/p2p/offer")
      );
    }),
    false,
  );
  assert.deepEqual(await context.cookies(origin), []);
  console.log(
    "P2P 直连重试、登录、文件权限、标签页存储丢失时恢复授权、普通与强制刷新、同浏览器重开、跨标签页退出、浏览器重开、链接隔离和撤销通过。",
  );
} finally {
  await context?.close();
  await app.close();
  await new Promise((resolve) => ingress.close(resolve));
  await new Promise((resolve) => backend.close(resolve));
  native.cleanup();
  await rm(directory, { recursive: true, force: true });
}

async function verifyConnectionRecovery(page, url, login, fetchOffer) {
  const routePath = "**/p2p/offer";
  const secondOffer = Promise.withResolvers();
  const retrying = page.getByRole("heading", { name: "正在重新尝试 P2P 直连" });
  const error = page.getByRole("alert");
  let attempts = 0;
  const failFirstHandshake = async (route) => {
    attempts++;
    if (attempts === 1) {
      const request = route.request();
      const response = await fetchOffer(request.url(), {
        method: request.method(),
        headers: request.headers(),
        body: request.postData(),
      });
      const { sdp } = await response.json();
      assert.equal(response.status, 200);
      // 保留真实信令和 ICE 候选，只让第一次 DTLS 握手失败。
      const invalid = sdp.replace(
        /(^a=fingerprint:sha-256 )[0-9a-f]/im,
        (match, prefix) => prefix + (match.endsWith("0") ? "1" : "0"),
      );
      assert.notEqual(invalid, sdp);
      await route.fulfill({ json: { sdp: invalid } });
    } else {
      await secondOffer.promise;
      await route.continue();
    }
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const waitForRelease = new Promise((resolve) => {
      window.releaseFixtureLoginCheck = resolve;
    });
    crypto.subtle.digest = async (...args) => {
      await waitForRelease;
      return digest(...args);
    };
  });
  await page.route(routePath, failFirstHandshake);
  try {
    await page.goto(url);
    await retrying.or(error).waitFor({ timeout: 45000 });
    if (await error.isVisible())
      await page.screenshot({ path: join(output, "connection-failed.png") });
    assert.equal(
      await retrying.isVisible(),
      true,
      await error.allTextContents(),
    );
    await page.screenshot({ path: join(output, "connection-retrying.png") });
    secondOffer.resolve();
    await page
      .getByRole("heading", { name: "直连已建立，正在检查登录" })
      .waitFor();
    await page.screenshot({
      path: join(output, "connection-checking-login.png"),
    });
    await page.evaluate(() => window.releaseFixtureLoginCheck());
    await login.waitFor({ timeout: 30000 });
    assert.equal(attempts, 2);
    await page.screenshot({ path: join(output, "connection-recovered.png") });
  } finally {
    secondOffer.resolve();
    await page.unroute(routePath, failFirstHandshake);
  }

  let unavailableAttempts = 0;
  const unavailable = async (route) => {
    unavailableAttempts++;
    await route.fulfill({ status: 502, body: "Fixture gateway unavailable" });
  };
  await page.route(routePath, unavailable);
  try {
    await page.reload();
    await error.filter({ hasText: "暂时无法通过 P2P 入口联系电脑" }).waitFor();
    assert.equal(unavailableAttempts, 2);
    const retry = page.getByRole("button", { name: "重试连接" });
    await retry.focus();
    assert.equal(
      await retry.evaluate((el) => el === document.activeElement),
      true,
    );
    await page.screenshot({
      path: join(output, "connection-signaling-error.png"),
    });
    await page.unroute(routePath, unavailable);
    await retry.press("Enter");
    await login.waitFor();
  } finally {
    await page.unroute(routePath, unavailable);
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
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

async function captureTotp(context, page, code, verify) {
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
          await page.waitForFunction(
            ({ scale, width }) =>
              Math.abs(devicePixelRatio - scale) < 0.02 &&
              Math.abs(innerWidth - width / scale) <= 1,
            { scale, width },
          );
          await code.scrollIntoViewIfNeeded();
          await page.getByLabel("验证器名称", { exact: true }).focus();
          assert.ok(
            await page
              .getByLabel("验证器名称", { exact: true })
              .evaluate((input) => {
                const { left, right, height } = input.getBoundingClientRect();
                return (
                  document.activeElement === input &&
                  left >= 0 &&
                  right <= innerWidth &&
                  height >= 40
                );
              }),
          );
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          );
          const box = await verify.evaluate((button) => {
            const { left, right, height } = button.getBoundingClientRect();
            return { left, right, height };
          });
          assert.ok(
            box.left >= 0 &&
              box.right <= width / scale + 1 &&
              Math.round(box.height) >= 40,
            `动态码提交按钮越出可用空间或高度不足：${width}px ${scale} ${theme} ${JSON.stringify(box)}`,
          );
          if (width === 390 && scale === 2) {
            const login = page.locator(".login-page");
            await login.evaluate((element) => element.scrollTo(0, 0));
            await page.mouse.move(95, 170);
            await page.mouse.wheel(0, 1600);
            await page.waitForFunction(
              () => document.querySelector(".login-page").scrollTop > 0,
            );
            await page.getByRole("button", { name: "复制绑定命令" }).focus();
            assert.equal(
              await page.evaluate(() =>
                document.activeElement.getAttribute("aria-label"),
              ),
              "复制绑定命令",
            );
          }
          if (scale === 1)
            await page.screenshot({
              path: join(output, `totp-${width}-${theme}.png`),
              fullPage: true,
              animations: "disabled",
            });
        }
      }
    }
  } finally {
    await zoom.selectOption("1");
    await settings.close();
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
}
