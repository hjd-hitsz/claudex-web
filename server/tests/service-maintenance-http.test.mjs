import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

test("authenticated HTTP restart survives the original process and restores its launch context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maintenance http "));
  const auth = await authenticationFixture(directory);
  const fixture = join(directory, "server.mjs");
  const imports = Object.fromEntries(
    [
      ["maintenance", "../src/service-maintenance.mjs"],
      ["handler", "../src/http/maintenance.mjs"],
      ["auth", "../src/auth.mjs"],
    ].map(([key, path]) => [key, new URL(path, import.meta.url).href]),
  );
  await writeFile(
    fixture,
    `import https from 'node:https';
import {readFile, writeFile} from 'node:fs/promises';
import {createServiceMaintenance} from ${JSON.stringify(imports.maintenance)};
import {createMaintenanceHandler} from ${JSON.stringify(imports.handler)};
import {createAuthentication} from ${JSON.stringify(imports.auth)};
const directory = import.meta.dirname;
if (process.cwd() !== directory || process.env.MAINTENANCE_FIXTURE !== 'preserved') process.exit(2);
let port = 0; try {port = Number(await readFile(directory + '/port', 'utf8'))} catch {}
const config = {configDir: directory, port, sessionDays: 30};
const authentication = await createAuthentication(config);
const service = createServiceMaintenance({config,version:{version:'4.0.1'},fetchVersion:async()=>'4.0.1'});
const handler = createMaintenanceHandler(service);
const server = https.createServer({key:await readFile(directory+'/tls/private-key.pem'),cert:await readFile(directory+'/tls/certificate.pem')}, async(req,res)=>{
  if(req.url === '/healthz') return res.end(JSON.stringify({version:{version:'4.0.1'},pid:process.pid}));
  if(authentication.authorize(req,res)) await handler(req,res,req.url);
});
server.listen(port,'127.0.0.1',async()=>{config.port=server.address().port;await writeFile(directory+'/port',String(config.port));});
process.once('SIGTERM',()=>{service.close();server.close(()=>process.exit());});
`,
  );
  let original, running, port;
  const request = httpsFetch(auth.tls.cert, auth.cookie);
  try {
    original = await spawnDetached(process.execPath, [fixture], {
      cwd: directory,
      env: { ...process.env, MAINTENANCE_FIXTURE: "preserved" },
      logFile: join(directory, "original.log"),
    });
    for (let i = 0; i < 100; i++) {
      try {
        port = Number(await readFile(join(directory, "port"), "utf8"));
        break;
      } catch {
        await delay(20);
      }
    }
    assert.ok(port, await readFile(join(directory, "original.log"), "utf8"));
    const origin = `https://127.0.0.1:${port}`;
    const response = await request(origin + "/api/maintenance/restart", {
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).task.mode, "process");
    let status;
    for (let i = 0; i < 200; i++) {
      await delay(30);
      try {
        status = JSON.parse(
          await readFile(join(directory, "maintenance/status.json"), "utf8"),
        );
        if (status.state === "completed" || status.state === "failed") break;
      } catch {}
    }
    assert.equal(status.state, "completed", status.error);
    const health = await (await request(origin + "/healthz")).json();
    running = await processIdentity(health.pid);
    assert.notEqual(health.pid, original.pid);
    assert.equal(await processAlive(original), false);
    const current = await (await request(origin + "/api/maintenance")).json();
    assert.equal(current.managed, false);
    assert.equal(current.task.state, "completed");
    assert.equal(
      (await stat(join(directory, "maintenance/job.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    if (running) await stopProcess(running);
    if (original) await stopProcess(original);
    await rm(directory, { recursive: true, force: true });
  }
});
