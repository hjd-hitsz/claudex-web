import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createP2pWire } from "../../shared/p2p-wire.mjs";
import { authenticationFixture } from "../../tests/helpers/auth.mjs";
import { createAuthentication } from "../src/auth.mjs";
import { createBusinessHttpHandler } from "../src/http/business.mjs";
import { createPeerClient } from "../src/p2p-peer.mjs";

test("直连保留 RPC 文本和文件 Range，并将管理入口留在 LAN", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-p2p-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "test.txt");
  const content = Buffer.from("WebRTC 文件\n".repeat(30000));
  await writeFile(path, content);
  const handle = createBusinessHttpHandler({
    translation: {},
    maintenance: {},
  });
  const { pamtester, cookie } = await authenticationFixture(directory);
  const config = {
    configDir: directory,
    pamtesterPath: pamtester,
    pamService: "login",
    sessionDays: 30,
  };
  const authentication = await createAuthentication(config);
  let authorized = 0;
  let loggedOut = 0;
  let channelClosed = false;
  const received = [];
  let onMessage;
  const browser = createP2pWire({
    sendFrame: (frame) => onMessage(frame),
    bufferedAmount: () => 0,
    receive: (message, bytes) => received.push({ message, bytes }),
    close: (error) => assert.fail(error),
  });
  const peer = createPeerClient(
    {
      sendMessageBinary: browser.frame,
      bufferedAmount: () => 0,
      onMessage: (callback) => {
        onMessage = callback;
      },
      close: () => {
        channelClosed = true;
      },
    },
    handle,
    {
      authentication,
      linkId: "fixture-link",
      onAuthenticated: () => authorized++,
      onLogout: () => loggedOut++,
    },
  );
  t.after(peer.detach);
  t.after(browser.close);
  peer.on("message", (text) => peer.send(text));
  async function authenticate(action, fields) {
    await browser.send({ type: "auth", action, ...fields });
    await until(() => received.length === 1);
    const { message } = received.shift();
    assert.equal(message.type, "auth-result");
    return message;
  }
  async function status(id, url) {
    await browser.send({ type: "request", id, method: "GET", url });
    await until(() =>
      received.some(
        ({ message }) => message.id === id && message.type === "end",
      ),
    );
    const response = received.shift().message;
    assert.equal(response.id, id);
    assert.equal(response.type, "response");
    assert.deepEqual(received.shift().message, { id, type: "end" });
    return response.status;
  }
  const fileUrl = "/api/files?" + new URLSearchParams({ path });
  const username = userInfo().username;
  assert.equal((await authenticate("resume")).session.authenticated, false);
  assert.equal(
    (await authenticate("resume", { token: cookie.split("=")[1] })).session
      .authenticated,
    false,
  );
  await browser.send({
    type: "rpc",
    text: JSON.stringify({ id: 1, method: "lan/terminal/create" }),
  });
  assert.equal(await status(1, fileUrl), 401);
  assert.equal(await status(2, "/api/maintenance"), 401);
  assert.match(
    (await authenticate("login", { username, password: "wrong" })).error,
    /用户名或密码错误/,
  );
  assert.equal(authorized, 0);
  const { session, token } = await authenticate("login", {
    username,
    password: "fixture-password",
  });
  assert.equal(session.authenticated, true);
  assert.equal(session.username, username);
  await until(() => authorized === 1);
  const stored = await createAuthentication(config);
  assert.equal(
    stored.resumePeer("fixture-link", token).session.authenticated,
    true,
  );
  assert.equal(
    stored.resumePeer("another-link", token).session.authenticated,
    false,
  );
  assert.equal(
    stored.valid(
      stored.sessionId({
        headers: { cookie: "__Host-claudex-web-session=" + token },
      }),
    ),
    null,
  );

  const text = JSON.stringify({ text: '汉字\"'.repeat(40000) });
  await browser.send({ type: "rpc", text });
  await until(() => received.length === 1);
  assert.deepEqual(received.shift().message, { type: "rpc", text });

  await browser.send({
    type: "request",
    id: 3,
    method: "GET",
    url: fileUrl,
    headers: { range: "bytes=1000-150000" },
  });
  await until(() => received.length === 1);
  const response = received.shift().message;
  assert.equal(response.status, 206);
  assert.equal(
    response.headers["content-range"],
    `bytes 1000-150000/${content.length}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.length, 0);

  const chunks = [];
  for (let n = 0; n < 3; n++) {
    await browser.send({ type: "pull", id: 3 });
    await until(() => received.length);
    const chunk = received.shift();
    assert.equal(chunk.message.type, "data");
    chunks.push(chunk.bytes);
  }
  await until(() => received.some(({ message }) => message.type === "end"));
  received.shift();
  assert.deepEqual(Buffer.concat(chunks), content.subarray(1000, 150001));

  assert.equal(await status(4, "/api/p2p"), 404);
  assert.equal((await authenticate("logout")).session.authenticated, false);
  assert.equal(loggedOut, 1);
  assert.equal(await status(5, fileUrl), 401);
  assert.equal(
    (await authenticate("resume", { token })).session.authenticated,
    false,
  );
  const relogin = await authenticate("login", {
    username,
    password: "fixture-password",
  });
  assert.equal(relogin.session.authenticated, true);
  await until(() => authorized === 2);
  assert.equal(channelClosed, false);
  await authentication.revokeLink("fixture-link");
  assert.equal(channelClosed, true);
  assert.equal(
    authentication.resumePeer("fixture-link", relogin.token).session
      .authenticated,
    false,
  );
});

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert(Date.now() < deadline, "等待接收直连消息超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
