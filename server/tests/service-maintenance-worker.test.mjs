import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authenticationFixture } from "../../tests/helpers/auth.mjs";
const execute = promisify(execFile);
for (const fail of [false, true])
  test(`isolated update worker ${fail ? "preserves old package on install failure" : "replaces package and checks HTTPS before completion"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "maintenance-worker-"));
    const { tls } = await authenticationFixture(directory);
    const server = https.createServer(tls, (_request, response) =>
      response.end(JSON.stringify({ version: { version: "4.0.2" } })),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const bin = join(directory, "bin");
      const root = join(directory, "lib/node_modules/@hjd-hitsz/claudex-web");
      await mkdir(bin);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "old"), "old package");
      await writeFile(
        join(bin, "npm"),
        `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); if (${fail}) process.exit(1); const prefix = process.argv[process.argv.indexOf('--prefix')+1]; const root = path.join(prefix, 'lib/node_modules/@hjd-hitsz/claudex-web'); fs.mkdirSync(path.join(root, 'client/dist'), {recursive:true}); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version:'4.0.2'})); fs.writeFileSync(path.join(root, 'client/dist/index.html'), 'new webpage');\n`,
        { mode: 0o700 },
      );
      await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      const job = {
        action: "update",
        root,
        prefix: directory,
        packageName: "@hjd-hitsz/claudex-web",
        task: { target: "4.0.2" },
        statusFile: join(directory, "status.json"),
        cert: join(directory, "tls/certificate.pem"),
        port: server.address().port,
      };
      await writeFile(join(directory, "job.json"), JSON.stringify(job));
      const operation = execute(
        process.execPath,
        [
          "server/src/service-maintenance-worker.mjs",
          join(directory, "job.json"),
        ],
        { env: { ...process.env, PATH: bin + ":" + process.env.PATH } },
      );
      if (fail) await assert.rejects(operation);
      else await operation;
      const status = JSON.parse(await readFile(job.statusFile));
      assert.equal(status.state, fail ? "failed" : "completed");
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
