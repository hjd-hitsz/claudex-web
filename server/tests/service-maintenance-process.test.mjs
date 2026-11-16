import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  authenticationFixture,
  httpsFetch,
} from "../../tests/helpers/auth.mjs";
import {
  processAlive,
  processIdentity,
  spawnDetached,
  stopProcess,
} from "../src/service-maintenance-process.mjs";

const execute = promisify(execFile);
for (const scenario of [
  "restart",
  "update",
  "install-failure",
  "startup-failure",
])
  test(`standalone maintenance with real HTTPS processes: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "maintenance process "));
    const { tls } = await authenticationFixture(directory);
    const root = join(directory, "lib/node_modules/@hjd-hitsz/claudex-web");
    const bin = join(directory, "bin");
    const portFile = join(directory, "port");
    const manifest = { version: "4.0.1" };
    const body = `import https from 'node:https';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root = import.meta.dirname;
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
if (${scenario === "startup-failure"} && version === '4.0.2') process.exit(1);
if (process.cwd() !== ${JSON.stringify(directory)} || process.env.FIXTURE_MARKER !== 'preserved') process.exit(2);
const portFile = ${JSON.stringify(portFile)};
let port = 0; try {port = Number(readFileSync(portFile))} catch {}
const server = https.createServer({key: readFileSync(${JSON.stringify(join(directory, "tls/private-key.pem"))}), cert: readFileSync(${JSON.stringify(join(directory, "tls/certificate.pem"))})}, (_req, res) => res.end(JSON.stringify({version: {version}, pid: process.pid})));
server.listen(port, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(join(directory, "closed-version"))}, JSON.parse(readFileSync(join(root, 'package.json'))).version);
  server.close(() => process.exit());
});
`;
    let original;
    let job;
    let running;
    try {
      await mkdir(root, { recursive: true });
      await mkdir(bin);
      await writeFile(join(root, "app.mjs"), body);
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));
      await writeFile(
        join(bin, "npm"),
        `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (${scenario === "install-failure"}) process.exit(1);
const root = path.join(process.argv[process.argv.indexOf('--prefix') + 1], 'lib/node_modules/@hjd-hitsz/claudex-web');
fs.mkdirSync(path.join(root, 'client/dist'), {recursive: true});
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version: '4.0.2'}));
fs.writeFileSync(path.join(root, 'client/dist/index.html'), 'new webpage');
fs.writeFileSync(path.join(root, 'app.mjs'), ${JSON.stringify(body)});
`,
        { mode: 0o700 },
      );
      const launch = {
        command: process.execPath,
        args: [join(root, "app.mjs")],
        env: { ...process.env, FIXTURE_MARKER: "preserved" },
        cwd: directory,
        logFile: join(directory, "web.log"),
      };
      original = await spawnDetached(launch.command, launch.args, launch);
      let port;
      for (let i = 0; i < 100; i++) {
        try {
          port = Number(await readFile(portFile, "utf8"));
          break;
        } catch {
          await delay(20);
        }
      }
      assert.ok(port, await readFile(launch.logFile, "utf8"));
      job = {
        action: scenario === "restart" ? "restart" : "update",
        root,
        prefix: directory,
        packageName: "@hjd-hitsz/claudex-web",
        process: { ...launch, identity: original },
        task: {
          mode: "process",
          state: "updating",
          target: scenario === "restart" ? "4.0.1" : "4.0.2",
        },
        statusFile: join(directory, "status.json"),
        cert: join(directory, "tls/certificate.pem"),
        port,
        environment: {
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        },
      };
      await writeFile(join(directory, "job.json"), JSON.stringify(job));
      const operation = execute(process.execPath, [
        "server/src/service-maintenance-worker.mjs",
        join(directory, "job.json"),
      ]);
      if (scenario.endsWith("failure")) await assert.rejects(operation);
      else await operation;
      const status = JSON.parse(await readFile(job.statusFile));
      assert.equal(
        status.state,
        scenario.endsWith("failure") ? "failed" : "completed",
      );
      const request = httpsFetch(tls.cert);
      let health;
      for (let i = 0; i < 100; i++) {
        try {
          health = await (
            await request(`https://127.0.0.1:${port}/healthz`)
          ).json();
          break;
        } catch {
          await delay(20);
        }
      }
      assert.equal(
        health.version.version,
        scenario === "update" ? "4.0.2" : "4.0.1",
      );
      running = await processIdentity(health.pid);
      assert.equal(
        await processAlive(original),
        scenario === "install-failure",
      );
      assert.equal(health.pid === original.pid, scenario === "install-failure");
      if (scenario !== "install-failure")
        assert.equal(
          await readFile(join(directory, "closed-version"), "utf8"),
          "4.0.1",
        );
      assert.equal(
        (await readdir(directory)).some((name) =>
          name.startsWith(".claudex-update-"),
        ),
        false,
      );
    } finally {
      if (running) await stopProcess(running);
      if (original) await stopProcess(original);
      await rm(directory, { recursive: true, force: true });
    }
  });

test("process identity mismatch leaves an unrelated process running", async () => {
  const current = await processIdentity(process.pid);
  await stopProcess({ ...current, startTime: "different" });
  assert.equal(await processAlive(current), true);
});

test("a web process ignoring SIGTERM is stopped after its graceful exit deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maintenance-stop-"));
  let child;
  try {
    const logFile = join(directory, "web.log");
    child = await spawnDetached(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)",
      ],
      { env: process.env, cwd: directory, logFile },
    );
    for (let i = 0; i < 100; i++) {
      if ((await readFile(logFile, "utf8")).includes("ready")) break;
      await delay(20);
    }
    await stopProcess(child, { timeout: 100 });
    assert.equal(await processAlive(child), false);
  } finally {
    if (child) await stopProcess(child, { timeout: 100 });
    await rm(directory, { recursive: true, force: true });
  }
});
