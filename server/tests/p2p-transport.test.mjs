import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createP2pWire } from "../../shared/p2p-wire.mjs";
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
      close: () => assert.fail("连接异常关闭"),
    },
    handle,
  );
  t.after(peer.detach);
  t.after(browser.close);
  peer.on("message", (text) => peer.send(text));
  const text = JSON.stringify({ text: '汉字\"'.repeat(40000) });
  await browser.send({ type: "rpc", text });
  await until(() => received.length === 1);
  assert.deepEqual(received.shift().message, { type: "rpc", text });

  await browser.send({
    type: "request",
    id: 1,
    method: "GET",
    url: "/api/files?" + new URLSearchParams({ path }),
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
    await browser.send({ type: "pull", id: 1 });
    await until(() => received.length);
    const chunk = received.shift();
    assert.equal(chunk.message.type, "data");
    chunks.push(chunk.bytes);
  }
  await until(() => received.some(({ message }) => message.type === "end"));
  assert.deepEqual(Buffer.concat(chunks), content.subarray(1000, 150001));

  await browser.send({
    type: "request",
    id: 2,
    method: "GET",
    url: "/api/p2p",
  });
  await until(() =>
    received.some(({ message }) => message.id === 2 && message.type === "end"),
  );
  assert.equal(
    received.find(({ message }) => message.id === 2).message.status,
    404,
  );
});

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert(Date.now() < deadline, "等待接收直连消息超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
