import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { authenticationFixture } from "../../tests/helpers/auth.mjs";
import { createAuthentication } from "../src/auth.mjs";
import { createP2pManagementHandler } from "../src/p2p/service.mjs";

const execute = promisify(execFile);
const cliPath = fileURLToPath(
  new URL("../../bin/claudex-web.mjs", import.meta.url),
);

test("P2P 命令认证本机服务，等待信令连接后只输出链接", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "claudex-p2p-cli-"));
  const { tls } = await authenticationFixture(configDir);
  const authentication = await createAuthentication({ configDir });
  const link = {
    id: "fixture-id",
    label: "手机 设备",
    createdAt: "2026-11-20T00:00:00.000Z",
    url: "https://p2p.example/p2p#fixture-token",
  };
  let enabled = false;
  let links = [];
  let checks = 0;
  const handler = createP2pManagementHandler({
    async manage(action, params) {
      if (action === "enable") enabled = true;
      if (action === "disable") enabled = false;
      if (action === "status" && enabled) checks++;
      let created;
      if (action === "create") {
        assert.ok(checks >= 2);
        assert.deepEqual(params, { label: link.label });
        created = link;
        links = [link];
      }
      if (action === "revoke") {
        assert.deepEqual(params, { id: link.id });
        links = [];
      }
      return {
        enabled,
        state: !enabled ? "disabled" : checks < 2 ? "connecting" : "online",
        origin: checks >= 2 ? "https://p2p.example" : null,
        error: null,
        links,
        created,
      };
    },
  });
  const server = createServer(tls, (request, response) => {
    if (!authentication.maintenance(request)) {
      response.writeHead(401).end('{"error":"未通过本机认证"}');
      return;
    }
    void handler(request, response, request.url);
  });
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(configDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const command = (...args) =>
    execute(process.execPath, [cliPath, "p2p", ...args], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(server.address().port),
        CLAUDEX_WEB_CONFIG_DIR: configDir,
      },
      timeout: 15000,
    });
  await assert.rejects(command("create"), { stderr: /P2P 已关闭/ });
  assert.match((await command("enable")).stdout, /正在连接/);
  const created = await command("create", "手机", "设备");
  assert.equal(created.stdout, `${link.url}\n`);
  assert.match(created.stderr, /正在等待 OpenTunnel 就绪/);
  assert.equal(
    (await command("list")).stdout.trim(),
    Object.values(link).join("\t"),
  );
  assert.match((await command("revoke", link.id)).stdout, /已撤销/);
  assert.match((await command("list")).stdout, /暂无授权链接/);
  assert.match((await command("disable")).stdout, /已关闭/);
});
