import assert from "node:assert/strict";
import { addAbortListener } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { createP2pService } from "../src/p2p/service.mjs";

async function waitFor(predicate) {
  const deadline = AbortSignal.timeout(12000);
  while (!predicate()) await wait(20, undefined, { signal: deadline });
}

function localRequest(url, { method, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers: response.headers,
          }),
        );
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("P2P 持久授权、独立信令入口与撤销已连接的授权", async (t) => {
  const native = await import("node-datachannel").catch(() => null);
  if (!native) {
    t.skip("当前平台未安装可选的 WebRTC 原生组件");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "claudex-p2p-test-"));
  const origin = "https://p2p.example";
  const fixture = { port: 0, state: "disabled", attached: 0, detached: 0 };
  async function runTunnel({ port, signal, onOrigin, onState }) {
    fixture.port = port;
    await onOrigin(origin);
    fixture.state = "online";
    onState("online");
    await new Promise((resolve) => addAbortListener(signal, resolve));
    fixture.state = "stopped";
  }
  const config = {
    configDirectory: directory,
    assetsDirectory: directory,
    runTunnel,
    connectPeer(channel) {
      fixture.attached++;
      channel.onMessage((message) => channel.sendMessage(`echo:${message}`));
      return () => fixture.detached++;
    },
  };
  let service = createP2pService(config);
  const remote = new native.PeerConnection("p2p-service-test", {
    iceServers: [],
  });
  t.after(async () => {
    remote.close();
    await service.close();
    native.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, "index.html"),
    "<!doctype html><p>Fixture</p>",
  );
  await writeFile(join(directory, "p2p-sw.js"), "// Fixture");
  await service.start();
  assert.deepEqual(await service.manage("status"), {
    enabled: false,
    state: "disabled",
    error: null,
    origin: null,
    links: [],
  });
  assert.equal(fixture.port, 0);
  await assert.rejects(service.manage("create"), { cause: 409 });
  await service.manage("enable");
  await waitFor(() => fixture.state === "online");

  const [{ created: phone }, { created: tablet }] = await Promise.all([
    service.manage("create", { label: " 手机 " }),
    service.manage("create", { label: "平板" }),
  ]);
  assert.equal(phone.label, "手机");
  for (const link of [phone, tablet]) {
    assert.equal(new URL(link.url).origin, origin);
    assert.match(new URL(link.url).hash, /^#[a-zA-Z0-9_-]{43}$/);
    assert.equal(new URL(link.url).pathname, "/p2p");
  }
  const persisted = await stat(join(directory, "p2p", "links.json"));
  assert.equal(persisted.mode & 0o777, 0o600);
  await service.close();
  service = createP2pService(config);
  await service.start();
  await waitFor(() => fixture.state === "online");
  assert.deepEqual((await service.manage("status")).links, [phone, tablet]);

  const local = () => `http://127.0.0.1:${fixture.port}`;
  const host = new URL(origin).host;
  const localFetch = (path) =>
    localRequest(`${local()}${path}`, { headers: { Host: host } });
  const page = await localFetch("/p2p");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(await page.text(), /Fixture/);
  assert.equal((await localFetch("/p2p-sw.js")).status, 200);
  for (const path of [
    "/api/p2p",
    "/api/files",
    "/rpc",
    "/maintenance",
    "/links.json",
  ])
    assert.equal((await localFetch(path)).status, 404);
  assert.equal((await localRequest(`${local()}/p2p`)).status, 421);

  const offer = (token, sdp, source = origin) =>
    localRequest(`${local()}/p2p/offer`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: source,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token, sdp }),
    });
  const token = new URL(phone.url).hash.slice(1);
  assert.equal((await offer(token, "", "https://wrong.example")).status, 403);
  assert.equal((await offer("unknown", "")).status, 401);
  assert.equal((await offer(token, "")).status, 400);

  const channel = remote.createDataChannel("claudex");
  let echoed;
  channel.onMessage((message) => {
    echoed = message;
  });
  await waitFor(() => remote.gatheringState() === "complete");
  const result = await offer(token, remote.localDescription().sdp);
  const answer = await result.json();
  assert.equal(result.status, 200, JSON.stringify(answer));
  remote.setRemoteDescription(answer.sdp, "answer");
  await waitFor(() => channel.isOpen() && fixture.attached === 1);
  assert.notEqual(remote.getSelectedCandidatePair()?.remote.type, "relay");
  channel.sendMessage("测试");
  await waitFor(() => echoed === "echo:测试");

  await service.manage("revoke", { id: phone.id });
  assert.equal(fixture.detached, 1);
  assert.equal((await offer(token, remote.localDescription().sdp)).status, 401);
  assert.deepEqual((await service.manage("status")).links, [tablet]);
  await service.manage("disable");
  assert.equal((await service.manage("status")).state, "disabled");
  await waitFor(() => fixture.state === "stopped");
  await service.manage("enable");
  await waitFor(() => fixture.state === "online");
  assert.deepEqual((await service.manage("status")).links, [tablet]);
  assert.equal((await offer(token, remote.localDescription().sdp)).status, 401);
});
