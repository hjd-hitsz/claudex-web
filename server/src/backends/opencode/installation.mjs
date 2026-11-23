import { dirname, join } from "node:path";
import { readFile, mkdir, rename, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { cliEnvironment } from "../cli-package.mjs";

export const opencodeVersion = "2.3.2";
export function runtimeDirectory(configDir) {
  return join(configDir, "runtimes", "opencode", opencodeVersion);
}
export async function resolveOpenCode(configDir) {
  const root = runtimeDirectory(configDir);
  const manifestPath = join(
    root,
    "node_modules",
    "@opencode",
    "sdk",
    "package.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("OpenCode 尚未安装，请在设置 → 后端中点击一键安装。");
    throw error;
  }
  if (manifest.version !== opencodeVersion)
    throw new Error("OpenCode SDK 版本不匹配，请重新安装。");
  return {
    entry: pathToFileURL(join(dirname(manifestPath), "dist", "index.js")).href,
    version: manifest.version,
  };
}
export function createOpenCodeInstallation({ configDir, run, changed }) {
  let current = {
    checking: false,
    installed: false,
    currentVersion: "",
    latestVersion: opencodeVersion,
  };
  let pending;
  const patch = (values) => {
    current = { ...current, ...values };
    changed();
  };
  async function refresh() {
    patch({ checking: true });
    try {
      const runtime = await resolveOpenCode(configDir);
      patch({ installed: true, currentVersion: runtime.version, error: "" });
    } catch (error) {
      patch({ installed: false, currentVersion: "", error: error.message });
    } finally {
      patch({ checking: false });
    }
    return current;
  }
  async function install() {
    if (pending) return pending;
    pending = (async () => {
      patch({ installing: true, installError: "" });
      const destination = runtimeDirectory(configDir);
      let temporary,
        previous,
        replaced = false;
      try {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        temporary = await mkdtemp(join(dirname(destination), ".install-"));
        previous = `${temporary}-previous`;
        await run(
          join(dirname(process.execPath), "npm"),
          [
            "install",
            "--prefix",
            temporary,
            "--no-audit",
            "--no-fund",
            `@opencode/sdk@${opencodeVersion}`,
          ],
          {
            timeout: 20 * 60 * 1000,
            maxBuffer: 4 * 1024 * 1024,
            env: cliEnvironment(),
          },
        );
        const entry = pathToFileURL(
          join(temporary, "node_modules/@opencode/sdk/dist/index.js"),
        ).href;
        await run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `await import(${JSON.stringify(entry)})`,
          ],
          { timeout: 30000, env: cliEnvironment() },
        );
        try {
          await rename(destination, previous);
          replaced = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        try {
          await rename(temporary, destination);
        } catch (error) {
          if (replaced) {
            await rename(previous, destination);
            replaced = false;
          }
          throw error;
        }
        await refresh();
        if (!current.installed) throw new Error(current.error);
      } catch (error) {
        if (replaced) {
          await rm(destination, { recursive: true, force: true });
          await rename(previous, destination);
          replaced = false;
        }
        patch({
          installError: error.message,
          installErrorDetails: error.stderr || error.message,
        });
        throw error;
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
        if (replaced) await rm(previous, { recursive: true, force: true });
        patch({ installing: false });
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  }
  return { state: () => current, refresh, install };
}
