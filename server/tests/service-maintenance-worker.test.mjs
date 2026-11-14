import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { authenticationFixture } from "../../tests/helpers/auth.mjs";
const execute = promisify(execFile);
for (const scenario of ["complete", "install-failure", "restart-failure"])
  test(`isolated update worker with separate npm environment: ${scenario}`, async () => {
    const fail = scenario !== "complete";
    const directory = await mkdtemp(join(tmpdir(), "maintenance-worker-"));
    const { tls } = await authenticationFixture(directory);
    const server = https.createServer(tls, (_request, response) =>
      response.end(JSON.stringify({ version: { version: "4.0.2" } })),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const bin = join(directory, "bin");
      const systemBin = join(directory, "system-bin");
      const root = join(directory, "lib/node_modules/@hjd-hitsz/claudex-web");
      await mkdir(bin);
      await mkdir(systemBin);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "old"), "old package");
      await writeFile(
        join(bin, "npm"),
        `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.env.npm_config_cache !== ${JSON.stringify(join(directory, "npm-cache"))}) process.exit(2);
if (${scenario === "install-failure"}) process.exit(1);
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
const root = path.join(prefix, 'lib/node_modules/@hjd-hitsz/claudex-web');
fs.mkdirSync(path.join(root, 'client/dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '4.0.2' }));
fs.writeFileSync(path.join(root, 'client/dist/index.html'), 'new webpage');
`,
        { mode: 0o700 },
      );
      const restartsFile = join(directory, "restarts.json");
      await writeFile(
        join(systemBin, "systemctl"),
        `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(restartsFile)};
const count = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) + 1 : 1;
fs.writeFileSync(file, JSON.stringify(count));
if (${scenario === "restart-failure"} && count === 1) process.exit(1);
`,
        { mode: 0o700 },
      );
      const job = {
        action: "update",
        root,
        prefix: directory,
        packageName: "@hjd-hitsz/claudex-web",
        task: { target: "4.0.2" },
        statusFile: join(directory, "status.json"),
        cert: join(directory, "tls/certificate.pem"),
        port: server.address().port,
        environment: {
          PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(
            delimiter,
          ),
          npm_config_cache: join(directory, "npm-cache"),
        },
      };
      await writeFile(join(directory, "job.json"), JSON.stringify(job));
      const operation = execute(
        process.execPath,
        [
          "server/src/service-maintenance-worker.mjs",
          join(directory, "job.json"),
        ],
        // 模拟 systemd 管理器的 PATH 缺少网页服务所用的 npm。
        {
          env: {
            ...process.env,
            PATH: systemBin,
          },
        },
      );
      if (fail) await assert.rejects(operation);
      else await operation;
      const status = JSON.parse(await readFile(job.statusFile));
      assert.equal(status.state, fail ? "failed" : "completed");
      if (scenario !== "install-failure")
        assert.equal(
          JSON.parse(await readFile(restartsFile)),
          scenario === "restart-failure" ? 2 : 1,
        );
      assert.equal(
        (await readdir(directory)).some((name) =>
          name.startsWith(".claudex-update-"),
        ),
        false,
      );
      assert.equal(
        await readFile(
          join(root, fail ? "old" : "client/dist/index.html"),
          "utf8",
        ),
        fail ? "old package" : "new webpage",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
