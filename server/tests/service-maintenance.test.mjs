import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { createServiceMaintenance } from "../src/service-maintenance.mjs";
import { createMaintenanceHandler } from "../src/http/maintenance.mjs";

test("version checks merge concurrent calls and retain metadata after failure", async () => {
  let calls = 0;
  const service = createServiceMaintenance({
    config: { configDir: tmpdir() },
    version: { version: "4.0.1" },
    run: async () => ({ stdout: String(process.pid) }),
    fetchVersion: async () => {
      calls++;
      if (calls > 1) throw new Error("registry unavailable");
      return "4.0.2";
    },
  });
  await Promise.all([service.check(), service.check()]);
  assert.equal(calls, 1);
  assert.equal((await service.status()).updateAvailable, true);
  await service.check();
  const status = await service.status();
  assert.equal(status.latest, "4.0.2");
  assert.equal(status.error, "registry unavailable");
});

test("restart is independent of updates and persists a worker job", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "maintenance-test-"));
  const commands = [];
  const service = createServiceMaintenance({
    config: { configDir, port: 1234 },
    version: { version: "4.0.1" },
    run: async (command, args) => {
      commands.push([command, args]);
      return { stdout: String(process.pid) };
    },
  });
  try {
    const status = await service.start("restart");
    assert.equal(status.task.state, "restarting");
    await service.start("restart");
    assert.equal(commands.filter(([name]) => name === "systemd-run").length, 1);
    const job = JSON.parse(
      await readFile(join(configDir, "maintenance/job.json")),
    );
    assert.equal(job.action, "restart");
    assert.equal(job.port, 1234);
    assert.equal(
      job.environment.PATH.split(delimiter)[0],
      dirname(process.execPath),
    );
    assert.equal(job.environment.HOME, process.env.HOME);
    assert.equal(job.environment.CLAUDEX_WEB_CONFIG_DIR, undefined);
    assert.match(
      await readFile(join(configDir, "maintenance/worker.mjs"), "utf8"),
      /node:https/,
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("failed systemd launch releases the submission gate and permits retry", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "maintenance-launch-"));
  let fail = true;
  const service = createServiceMaintenance({
    config: { configDir, port: 1234 },
    version: { version: "4.0.1" },
    run: async (command) => {
      if (command === "systemd-run" && fail) throw new Error("launch failed");
      return { stdout: String(process.pid) };
    },
  });
  try {
    await assert.rejects(service.start("restart"), /launch failed/);
    assert.equal(service.switching, false);
    assert.equal((await service.status()).task.state, "failed");
    fail = false;
    assert.equal((await service.start("restart")).task.state, "restarting");
  } finally {
    service.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test("unmanaged process returns an actionable failure", async () => {
  const service = createServiceMaintenance({
    config: { configDir: tmpdir() },
    version: { version: "4.0.1" },
    run: async () => ({ stdout: "0" }),
  });
  await assert.rejects(service.start("restart"), /service install/);
});

test("maintenance routes reject unsupported requests", async () => {
  const handler = createMaintenanceHandler({
    status: async () => ({ current: "4.0.1" }),
  });
  let code, body;
  const response = {
    setHeader() {},
    writeHead(value) {
      code = value;
    },
    end(value) {
      body = JSON.parse(value);
    },
  };
  await handler({ method: "GET" }, response, "/api/maintenance");
  assert.equal(body.current, "4.0.1");
  await handler({ method: "DELETE" }, response, "/api/maintenance/restart");
  assert.equal(code, 405);
});

test("active conversations reject maintenance without scheduling a task", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "maintenance-busy-"));
  let launched = 0;
  const service = createServiceMaintenance({
    config: { configDir },
    version: { version: "4.0.1" },
    isBusy: () => true,
    run: async (command) => {
      if (command === "systemd-run") launched++;
      return { stdout: String(process.pid) };
    },
  });
  try {
    await assert.rejects(service.start("restart"), /请结束后重试/);
    assert.equal(launched, 0);
    assert.equal(service.switching, false);
    assert.equal((await service.status()).task, null);
  } finally {
    service.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
