import { execFile, spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writePrivateFile } from "../../private-file.mjs";

const exec = promisify(execFile);
export const workerEntry = fileURLToPath(
  new URL("./worker-server.mjs", import.meta.url),
);

export async function launchAgyWorker(backend, config, version, location) {
  const options = join(backend.stateDir, "worker-options.json");
  const runtimeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|(?:HTTP|HTTPS|ALL|NO)_PROXY|(?:http|https|all|no)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(?:FILE|DIR)|GEMINI_.*|GOOGLE_.*|ANTHROPIC_.*|CLAUDE_CODE_.*|XDG_.*|DBUS_SESSION_BUS_ADDRESS)$/.test(
        key,
      ),
    ),
  );
  await writePrivateFile(
    options,
    JSON.stringify({ backend, config, version, runtimeEnv }),
  );
  const args = [workerEntry, location.socket, options];
  const systemd = await exec("systemctl", ["--user", "show-environment"], {
    timeout: 3000,
  }).then(
    () => true,
    () => false,
  );
  if (systemd) {
    await exec(
      "systemd-run",
      [
        "--user",
        "--quiet",
        "--collect",
        `--unit=${location.unit}`,
        "--property=Type=exec",
        "--property=Restart=on-failure",
        process.execPath,
        ...args,
      ],
      { timeout: 15000 },
    );
    return;
  }
  const log = await open(join(backend.stateDir, "worker.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
}
