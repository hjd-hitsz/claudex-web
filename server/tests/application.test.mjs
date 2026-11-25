import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { createWebApplication } from "../src/application.mjs";
import { createAuthentication } from "../src/auth.mjs";
import { readConfig } from "../src/config.mjs";
import {
  authenticationFixture,
  httpsFetch,
} from "../../tests/helpers/auth.mjs";

test("应用实例隔离资源缓存，关闭后释放监听与后端连接", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-web-application-"));
  const backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(backend, "listening");
  let connections = 0;
  backend.on("connection", (socket) => {
    connections++;
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes);
      if (message.method === "initialize")
        socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  const apps = new Set();
  async function closeApplication(app) {
    await app.close();
    apps.delete(app);
  }
  t.after(async () => {
    await Promise.all([...apps].map(closeApplication));
    for (const socket of backend.clients) socket.terminate();
    await new Promise((resolve) => backend.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function resources(name) {
    const configDir = join(directory, name);
    const staticDir = join(configDir, "static");
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "file-panel.js"), name);
    const auth = await authenticationFixture(configDir);
    return {
      configDir,
      staticDir,
      tls: auth.tls,
      request: httpsFetch(auth.tls.cert, auth.cookie),
    };
  }
  async function application({ configDir, staticDir, tls }, port = 0) {
    const config = readConfig({
      CODEX_HOME: configDir,
      CLAUDE_CONFIG_DIR: join(configDir, ".claude"),
      CLAUDEX_WEB_CONFIG_DIR: configDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      STATIC_DIR: staticDir,
      CODEX_APP_SERVER_URL: `ws://127.0.0.1:${backend.address().port}`,
    });
    const app = createWebApplication({
      config,
      tls,
      authentication: await createAuthentication(config),
      version: { displayVersion: "fixture" },
    });
    apps.add(app);
    try {
      await app.start();
    } catch (error) {
      await closeApplication(app);
      throw error;
    }
    return app;
  }
  const firstResources = await resources("first");
  const secondResources = await resources("second");
  const conflictResources = await resources("conflict");
  const first = await application(firstResources);
  const second = await application(secondResources);
  const url = (app) => `https://127.0.0.1:${app.server.address().port}`;
  for (const [app, request, name] of [
    [first, firstResources.request, "first"],
    [second, secondResources.request, "second"],
  ]) {
    const response = await request(url(app) + "/file-panel.js", {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.equal(await response.text(), name);
  }
  await assert.rejects(
    application(conflictResources, first.server.address().port),
    { code: "EADDRINUSE" },
  );
  const beforeClose = connections;
  assert.equal(beforeClose, 2);
  const closedUrl = url(first);
  await closeApplication(first);
  await closeApplication(second);
  await assert.rejects(firstResources.request(closedUrl + "/file-panel.js"));
  await delay(2100);
  assert.equal(backend.clients.size, 0);
  assert.equal(connections, beforeClose);
  const recovered = await application(conflictResources);
  const response = await conflictResources.request(
    url(recovered) + "/file-panel.js",
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "conflict");
});
