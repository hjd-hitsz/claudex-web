import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, stat, open } from "node:fs/promises";
import { networkInterfaces, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import {
  authenticationFixture,
  fixtureTotpCode,
  httpsFetch,
} from "../../tests/helpers/auth.mjs";
import { readConfig } from "../src/config.mjs";
import { authenticateSystemUser } from "../src/system-auth.mjs";
import { totpCode } from "../src/auth-totp.mjs";

test("六位动态码与 RFC 6238 SHA-1 测试向量一致", () => {
  const seed = Buffer.from("12345678901234567890");
  assert.equal(totpCode(seed, 1), "287082");
  assert.equal(totpCode(seed, 37037036), "081804");
  assert.equal(totpCode(seed, 666666666), "353130");
});

async function appFixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), "claudex-web-auth-"));
  const auth = await authenticationFixture(directory, options);
  await writeFile(join(directory, "index.html"), "<h1>Login shell</h1>");
  await writeFile(join(directory, "private.txt"), "protected file");
  const backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(backend, "listening");
  const requests = [];
  let running = false;
  backend.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes);
      requests.push(request);
      if (request.method === "initialize")
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      else if (request.method === "turn/start") {
        running = true;
        socket.send(
          JSON.stringify({
            method: "turn/started",
            params: {
              threadId: "fixture-thread",
              turn: { id: "fixture-turn" },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { turn: { id: "fixture-turn", status: "inProgress" } },
          }),
        );
      } else if (request.method === "thread/resume")
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: request.params.threadId,
                status: { type: running ? "active" : "idle" },
              },
            },
          }),
        );
      else if (request.id !== undefined)
        socket.send(JSON.stringify({ id: request.id, result: {} }));
    }),
  );
  let child,
    exited,
    url,
    log = "";
  const sockets = [];
  const start = async () => {
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/server.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          HOST: options?.host || "127.0.0.1",
          PORT: "0",
          CODEX_HOME: directory,
          CLAUDEX_WEB_CONFIG_DIR: directory,
          STATIC_DIR: directory,
          AUTH_PAMTESTER: auth.pamtester,
          AUTH_SESSION_DAYS: "30",
          CODEX_APP_SERVER_URL: `ws://127.0.0.1:${backend.address().port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    exited = once(child, "exit");
    child.stderr.on("data", (bytes) => {
      log += bytes;
    });
    url = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`服务提前退出 ${code}: ${log}`)),
      );
      child.stdout.on("data", (bytes) => {
        const match = String(bytes).match(
          /https:\/\/(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/,
        );
        if (match) resolve(`https://127.0.0.1:${match[1]}`);
      });
    });
    for (let i = 0; i < 100; i++) {
      if ((await httpsFetch(auth.tls.cert)(url + "/healthz")).status === 200)
        break;
      await delay(10);
    }
  };
  const stop = async () => {
    if (child?.exitCode === null) {
      child.kill();
      await exited;
    }
  };
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await stop();
    for (const socket of backend.clients) socket.terminate();
    await new Promise((resolve) => backend.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  return {
    auth,
    directory,
    requests,
    start,
    stop,
    log: () => log,
    url: () => url,
    request(path, options = {}, cookie = "") {
      return httpsFetch(auth.tls.cert, cookie)(url + path, options);
    },
    async authPost(action, input, cookie = "") {
      return this.request(
        "/api/auth/" + action,
        {
          method: "POST",
          headers: {
            Origin: url,
            "X-Claudex-Web-Request": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        },
        cookie,
      );
    },
    login(password = "fixture-password", cookie = "") {
      return this.authPost(
        "login",
        { username: userInfo().username, password },
        cookie,
      );
    },
    async signIn() {
      const pending = await this.login();
      return this.authPost(
        "totp",
        { code: fixtureTotpCode(directory) },
        pending.headers.get("set-cookie").split(";")[0],
      );
    },
    connect(cookie = auth.cookie, path = "/rpc", headers = { Origin: url }) {
      const socket = new WebSocket(url.replace("https:", "wss:") + path, {
        ca: auth.tls.cert,
        headers: { Cookie: cookie, ...headers },
      });
      sockets.push(socket);
      return socket;
    },
  };
}
test("未登录可下载当前公开证书并核对指纹，其他方法及业务数据保持受限", async (t) => {
  const app = await appFixture(t);
  const info = await (await app.request("/api/tls/info")).json();
  const expected = new X509Certificate(app.auth.tls.cert);
  assert.deepEqual(info, {
    fingerprint: expected.fingerprint256,
    validTo: expected.validTo,
    selfSigned: true,
  });
  const response = await app.request("/api/tls/certificate");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pkix-cert");
  assert.match(
    response.headers.get("content-disposition"),
    /attachment; filename="claudex-web.cer"/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, expected.raw);
  assert.equal(new X509Certificate(bytes).fingerprint256, info.fingerprint);
  const head = await app.request("/api/tls/certificate", { method: "HEAD" });
  assert.equal(await head.text(), "");
  assert.equal(Number(head.headers.get("content-length")), bytes.length);
  for (const path of ["/api/tls/info", "/api/tls/certificate"]) {
    const denied = await app.request(path, { method: "POST" });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get("allow"), "GET, HEAD");
  }
  assert.equal((await app.request("/api/files?path=/etc/passwd")).status, 401);
});

function state(socket) {
  return new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes);
      if (message.method === "lan/state" && message.params.ready)
        resolve(message.params);
    });
  });
}
function rejected(socket) {
  return new Promise((resolve) => {
    socket.on("unexpected-response", (_, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
    socket.on("error", () => {});
  });
}

test(
  "HTTPS 默认保护业务、阻止明文、跨站和无会话 WebSocket",
  { timeout: 15000 },
  async (t) => {
    const app = await appFixture(t);
    assert.equal((await app.request("/")).status, 200);
    assert.deepEqual(await (await app.request("/api/auth/session")).json(), {
      authenticated: false,
    });
    for (const path of [
      "/api/files?path=" +
        encodeURIComponent(join(app.directory, "private.txt")),
      "/api/media?path=/etc/passwd",
      "/api/translate",
    ])
      for (const method of ["GET", "HEAD", "POST"])
        assert.equal((await app.request(path, { method })).status, 401);
    assert.equal(await rejected(app.connect("")), 401);
    assert.equal(
      await rejected(
        app.connect(app.auth.cookie, "/rpc", {
          Origin: "https://evil.example",
        }),
      ),
      401,
    );
    assert.equal(await rejected(app.connect(app.auth.cookie, "/rpc", {})), 401);
    await assert.rejects(
      new Promise((resolve, reject) =>
        http
          .get(app.url().replace("https:", "http:") + "/", resolve)
          .on("error", reject),
      ),
    );
    const cross = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "X-Claudex-Web-Request": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(cross.status, 403);
    assert.equal(
      (
        await app.request(
          "/api/auth/logout",
          { method: "POST" },
          app.auth.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request(
          "/api/files?path=/etc/passwd",
          { headers: { Origin: "https://evil.example" } },
          app.auth.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request("/api/auth/login", {
          method: "POST",
          headers: {
            Origin: app.url(),
            "X-Claudex-Web-Request": "1",
            "Content-Type": "application/json",
          },
          body: "{",
        })
      ).status,
      400,
    );
  },
);

test(
  "密码验证、持久 Cookie、服务重启恢复及注销立即撤销多个连接",
  { timeout: 20000 },
  async (t) => {
    const app = await appFixture(t);
    assert.equal((await app.login("wrong")).status, 401);
    assert.equal((await app.login("unavailable")).status, 503);
    const login = await app.signIn();
    assert.equal(login.status, 200);
    const header = login.headers.get("set-cookie");
    for (const value of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/",
      "Max-Age=2592000",
    ])
      assert(header.includes(value));
    assert(!header.includes("fixture-password"));
    const cookie = header.split(";")[0];
    const session = await login.json();
    assert(session.expiresAt > Date.now() + 29 * 86400000);
    assert.equal(
      (await (await app.request("/api/auth/session", {}, cookie)).json())
        .authenticated,
      true,
    );
    const stored = await readFile(
      join(app.auth.authDirectory, "sessions.json"),
      "utf8",
    );
    assert(!stored.includes(cookie.split("=")[1]));
    assert(!stored.includes("fixture-password"));
    assert.equal(
      (await stat(join(app.auth.authDirectory, "sessions.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      await (
        await app.request(
          "/api/files?path=" +
            encodeURIComponent(join(app.directory, "private.txt")),
          {},
          cookie,
        )
      ).text(),
      "protected file",
    );
    await app.stop();
    await app.start();
    assert.equal(
      (await (await app.request("/api/auth/session", {}, cookie)).json())
        .authenticated,
      true,
    );
    const first = app.connect(cookie),
      second = app.connect(cookie);
    await Promise.all([state(first), state(second)]);
    const turned = new Promise((resolve) =>
      first.on("message", (bytes) => {
        const m = JSON.parse(bytes);
        if (m.id === 7) resolve(m);
      }),
    );
    first.send(
      JSON.stringify({
        id: 7,
        method: "turn/start",
        params: {
          threadId: "fixture-thread",
          input: [{ type: "text", text: "isolated task" }],
        },
      }),
    );
    await turned;
    const closed = Promise.all([once(first, "close"), once(second, "close")]);
    const logout = await app.request(
      "/api/auth/logout",
      {
        method: "POST",
        headers: { Origin: app.url(), "X-Claudex-Web-Request": "1" },
      },
      cookie,
    );
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.deepEqual(
      (await closed).map((result) => result[0]),
      [4401, 4401],
    );
    assert.equal(
      (await app.request("/api/files?path=/etc/passwd", {}, cookie)).status,
      401,
    );
    assert.equal(await rejected(app.connect(cookie)), 401);
    assert(
      !app.requests.some((request) =>
        ["turn/interrupt", "command/exec/terminate"].includes(request.method),
      ),
    );
    const monitor = app.connect("", "/maintenance", {
      Authorization: "Bearer fixture-maintenance-token",
    });
    const active = await state(monitor);
    assert.equal(active.activeTurns["fixture-thread"], "fixture-turn");
    assert(!Object.hasOwn(active, "defaultCwd"));
    const monitorClosed = once(monitor, "close");
    monitor.send(JSON.stringify({ method: "thread/list" }));
    assert.equal((await monitorClosed)[0], 1008);
    await app.stop();
    await app.start();
    assert.equal(
      (await (await app.request("/api/auth/session", {}, cookie)).json())
        .authenticated,
      false,
    );
    assert(!app.log().includes("fixture-password"));
  },
);

test(
  "过期会话关闭 WSS，超长 Cookie 有效期不会造成计时器溢出",
  { timeout: 15000 },
  async (t) => {
    const app = await appFixture(t);
    await app.stop();
    await writeFile(
      join(app.auth.authDirectory, "sessions.json"),
      JSON.stringify([
        [app.auth.id, { ...app.auth.session, expiresAt: Date.now() + 1200 }],
      ]),
    );
    await app.start();
    const socket = app.connect();
    await state(socket);
    assert.equal((await once(socket, "close"))[0], 4401);
    assert.equal(
      (await app.request("/api/files?path=/etc/passwd", {}, app.auth.cookie))
        .status,
      401,
    );
    const response = await app.signIn();
    const long = app.connect(response.headers.get("set-cookie").split(";")[0]);
    await state(long);
    await delay(50);
    assert.equal(long.readyState, WebSocket.OPEN);
    assert(!app.log().includes("TimeoutOverflowWarning"));
  },
);

test(
  "旧会话失效，密码通过后可在线绑定，当前验证器决定会话权限",
  { timeout: 20000 },
  async (t) => {
    const app = await appFixture(t, { legacy: true });
    const cli = fileURLToPath(
      new URL("../../bin/claudex-web.mjs", import.meta.url),
    );
    const env = {
      ...process.env,
      CLAUDEX_WEB_CONFIG_DIR: app.directory,
      CODEX_HOME: app.directory,
    };
    const getSession = async (cookie) =>
      (await app.request("/api/auth/session", {}, cookie)).json();
    const pendingCookie = async () => {
      const response = await app.login();
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie");
      assert.match(
        cookie,
        /^__Host-claudex-web-login=.+HttpOnly; Secure; SameSite=Strict/,
      );
      assert.equal((await response.json()).requiresTotp, true);
      return cookie.split(";")[0];
    };
    assert.equal((await getSession(app.auth.cookie)).authenticated, false);
    assert.equal(await rejected(app.connect(app.auth.cookie)), 401);
    const pending = await pendingCookie();
    assert.equal((await getSession(pending)).requiresTotp, true);
    assert.equal(
      (await app.request("/api/files?path=/etc/passwd", {}, pending)).status,
      401,
    );
    assert.equal(await rejected(app.connect(pending)), 401);
    assert.equal((await app.authPost("totp", { code: "123456" })).status, 410);
    assert.equal(
      (await app.authPost("totp", { code: "123456" }, pending)).status,
      409,
    );
    const setup = () =>
      execFileSync(process.execPath, [cli, "auth", "setup"], {
        env,
        encoding: "utf8",
        stdio: "pipe",
      });
    const qr = setup();
    assert.match(qr, /扫描二维码/);
    assert.match(qr, /[▄▀█]/);
    assert.equal(setup(), qr);
    assert.equal((await getSession(app.auth.cookie)).authenticated, false);
    assert.equal((await getSession(pending)).totpStatus, "pending");
    assert.equal(
      (await stat(join(app.auth.authDirectory, "totp.sqlite"))).mode & 0o777,
      0o600,
    );
    const otherPending = await pendingCookie();
    const code = fixtureTotpCode(app.directory);
    assert.equal(
      (
        await app.request(
          "/api/auth/totp",
          {
            method: "POST",
            headers: {
              Origin: "https://other.example",
              "X-Claudex-Web-Request": "1",
            },
          },
          pending,
        )
      ).status,
      403,
    );
    const results = await Promise.all(
      [pending, otherPending].map((token) =>
        app.authPost("totp", { code }, token),
      ),
    );
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [200, 401],
    );
    const completed = results.find((response) => response.ok);
    const verifiedCookie = completed.headers.get("set-cookie").split(";")[0];
    assert.equal((await completed.json()).totpStatus, "enabled");
    assert.throws(setup, /验证器已绑定/);
    assert.equal((await getSession(app.auth.cookie)).authenticated, false);
    assert.equal((await getSession(verifiedCookie)).totpStatus, "enabled");
    const beforeRestart = await pendingCookie();
    await app.stop();
    await app.start();
    assert.equal(
      (await app.authPost("totp", { code }, beforeRestart)).status,
      410,
    );
    const afterRestart = await pendingCookie();
    assert.equal(
      (await app.authPost("totp", { code }, afterRestart)).status,
      401,
    );
    const disable = (input) =>
      execFileSync(process.execPath, [cli, "auth", "disable"], {
        env,
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    disable("no\n");
    assert.equal((await getSession(verifiedCookie)).totpStatus, "enabled");
    assert.match(disable("yes\n"), /双重验证已关闭/);
    assert.equal((await getSession(verifiedCookie)).authenticated, false);
    assert.equal(
      (await app.authPost("totp", { code }, afterRestart)).status,
      410,
    );
    const passwordOnly = await app.login();
    assert.equal((await passwordOnly.json()).totpStatus, "disabled");
    assert.match(
      passwordOnly.headers.get("set-cookie"),
      /^__Host-claudex-web-session=/,
    );
    const passwordCookie = passwordOnly.headers.get("set-cookie").split(";")[0];
    const ws = app.connect(passwordCookie);
    await state(ws);
    const closed = once(ws, "close");
    assert.notEqual(setup(), qr);
    assert.equal((await closed)[0], 4401);
    assert.equal((await getSession(passwordCookie)).authenticated, false);
    assert.equal((await getSession(app.auth.cookie)).authenticated, false);
  },
);

test("输错五次动态码后需要重新验证系统密码", async (t) => {
  const app = await appFixture(t);
  const pending = (await app.login()).headers.get("set-cookie").split(";")[0];
  const possible = [-1, 0, 1, 2].map((step) =>
    fixtureTotpCode(app.directory, step),
  );
  const wrong = ["000000", "111111", "222222", "333333", "444444"].find(
    (code) => !possible.includes(code),
  );
  for (let index = 0; index < 4; index++)
    assert.equal(
      (await app.authPost("totp", { code: wrong }, pending)).status,
      401,
    );
  assert.equal(
    (await app.authPost("totp", { code: wrong }, pending)).status,
    410,
  );
  assert.equal(
    (
      await app.authPost(
        "totp",
        { code: fixtureTotpCode(app.directory) },
        pending,
      )
    ).status,
    410,
  );
});

test("本机直连可用系统密码登录，网卡地址与回环均可用，本机会话只能在本机使用", async (t) => {
  const app = await appFixture(t, { legacy: true, host: "0.0.0.0" });
  const lan =
    Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address ||
    "127.0.0.2";
  const origin = new URL(app.url());
  const credentials = JSON.stringify({
    username: userInfo().username,
    password: "fixture-password",
  });
  const headers = {
    "X-Claudex-Web-Request": "1",
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
  };
  let localCookie;
  for (const address of ["127.0.0.1", lan]) {
    origin.hostname = address;
    const local = await httpsFetch(app.auth.tls.cert)(
      origin.origin + "/api/auth/login",
      {
        method: "POST",
        headers: { ...headers, Origin: origin.origin },
        body: credentials,
      },
    );
    assert.equal(local.status, 200);
    const session = await local.json();
    assert.equal(session.authenticated, true);
    assert.equal(session.kind, "local");
    assert.equal(session.totpStatus, "setup");
    localCookie = local.headers.get("set-cookie").split(";")[0];
  }
  const live = app.connect(localCookie);
  assert.equal((await state(live)).ready, true);
  const differentPeer = await app.request("/api/auth/login", {
    method: "POST",
    localAddress: "127.0.0.2",
    headers: { ...headers, Origin: app.url() },
    body: credentials,
  });
  assert.equal((await differentPeer.json()).requiresTotp, true);
  for (const proxy of [
    { Forwarded: "for=192.0.2.20" },
    { Host: "bridge.example.test", Origin: "https://bridge.example.test" },
  ]) {
    const remote = await app.request("/api/auth/login", {
      method: "POST",
      headers: { ...headers, Origin: app.url(), ...proxy },
      body: credentials,
    });
    assert.equal((await remote.json()).requiresTotp, true);
    assert.equal(
      (
        await app.request(
          "/api/files?path=/etc/hostname",
          { headers: proxy },
          localCookie,
        )
      ).status,
      401,
    );
    assert.equal(
      await rejected(
        app.connect(localCookie, "/rpc", { Origin: app.url(), ...proxy }),
      ),
      401,
    );
  }
  const getSession = async () =>
    (await app.request("/api/auth/session", {}, localCookie)).json();
  assert.equal((await getSession()).kind, "local");
  await app.stop();
  await app.start();
  assert.equal((await getSession()).authenticated, true);
});

test(
  "登录限流、账户拒绝及验证程序缺失保持拒绝访问",
  { timeout: 15000 },
  async (t) => {
    const app = await appFixture(t);
    for (let index = 0; index < 10; index++)
      assert.equal((await app.login("wrong")).status, 401);
    const response = await app.login();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "900");
    assert.equal(
      await authenticateSystemUser("other-user", "fixture-password", {
        pamtesterPath: app.auth.pamtester,
        pamService: "login",
      }),
      false,
    );
    assert.equal(
      await authenticateSystemUser(userInfo().username, "", {
        pamtesterPath: app.auth.pamtester,
        pamService: "login",
      }),
      false,
    );
    assert.equal(
      await authenticateSystemUser(userInfo().username, "a\nb", {
        pamtesterPath: app.auth.pamtester,
        pamService: "login",
      }),
      false,
    );
    await assert.rejects(
      authenticateSystemUser(userInfo().username, "test", {
        pamtesterPath: join(app.directory, "missing"),
        pamService: "login",
      }),
      /登录暂不可用/,
    );
  },
);

test("HTTPS 与登录配置校验", () => {
  assert.equal(readConfig({}).sessionDays, 30);
  for (const value of ["0", "91", "1.5", "no"])
    assert.throws(
      () => readConfig({ AUTH_SESSION_DAYS: value }),
      /AUTH_SESSION_DAYS/,
    );
  assert.throws(() => readConfig({ TLS_CERT: "cert.pem" }), /TLS_CERT/);
  assert.throws(
    () => readConfig({ AUTH_PAM_SERVICE: "../login" }),
    /AUTH_PAM_SERVICE/,
  );
  assert.throws(
    () => readConfig({ CODEX_APP_SERVER_URL: "ws://192.0.2.10:8765" }),
    /wss/,
  );
  assert.equal(
    readConfig({ CODEX_APP_SERVER_URL: "wss://backend.example" }).upstreamUrl,
    "wss://backend.example",
  );
});

test(
  "退出立即撤销进行中的文件传输，并拒绝超长登录请求",
  { timeout: 15000 },
  async (t) => {
    const app = await appFixture(t);
    const file = join(app.directory, "large.bin");
    const handle = await open(file, "w");
    await handle.truncate(64 * 1024 * 1024);
    await handle.close();
    const response = await new Promise((resolve, reject) => {
      const request = https.get(
        app.url() + "/api/files?path=" + encodeURIComponent(file),
        { ca: app.auth.tls.cert, headers: { Cookie: app.auth.cookie } },
        resolve,
      );
      request.on("error", reject);
      t.after(() => request.destroy());
    });
    assert.equal(response.statusCode, 200);
    response.pause();
    const ended = new Promise((resolve) => {
      response.on("aborted", () => resolve("aborted"));
      response.on("end", () => resolve("end"));
      response.on("error", () => {});
    });
    assert.equal(
      (
        await app.request(
          "/api/auth/logout",
          {
            method: "POST",
            headers: { Origin: app.url(), "X-Claudex-Web-Request": "1" },
          },
          app.auth.cookie,
        )
      ).status,
      200,
    );
    response.resume();
    assert.equal(await ended, "aborted");
    const oversized = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        Origin: app.url(),
        "X-Claudex-Web-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "demo", password: "x".repeat(9000) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await app.request("/healthz")).status, 200);
  },
);
