import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { installCpuRuntime, runtimeVersion } from "./cpu-runtime.mjs";
import { modelId, resolveComponents } from "./catalog.mjs";
import { downloadArchive, extractComponent } from "./download.mjs";

export function defaultModelDirectory() {
  return join(homedir(), ".local", "share", "claudex-translation", "models");
}
class ModelIntegrityError extends Error {}

export class ModelStore {
  constructor(
    directory = defaultModelDirectory(),
    {
      catalog = resolveComponents,
      request = fetch,
      installRuntime = installCpuRuntime,
    } = {},
  ) {
    this.directory = join(directory, modelId);
    this.catalog = catalog;
    this.request = request;
    this.installRuntime = installRuntime;
  }
  async installed() {
    let index;
    try {
      index = JSON.parse(
        await readFile(join(this.directory, "installed.json"), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!/^\d+(\.\d+){3}-\d+(\.\d+){3}$/.test(index.version))
      throw new ModelIntegrityError("模型版本记录无效");
    const directory = join(this.directory, index.version);
    const receipt = JSON.parse(
      await readFile(join(directory, "ready.json"), "utf8"),
    );
    if (receipt.runtimeVersion !== runtimeVersion)
      throw new ModelIntegrityError("CPU 运行库版本需要更新");
    if (!receipt.files || Object.keys(receipt.files).length < 10)
      throw new ModelIntegrityError("模型文件清单不完整");
    for (const file of Object.keys(receipt.files)) {
      if (!/^(model|runtime)\//.test(file) || file.split("/").includes(".."))
        throw new ModelIntegrityError("模型文件路径无效");
      const entry = await stat(join(directory, file));
      if (entry.size !== receipt.files[file].size)
        throw new ModelIntegrityError("模型文件不完整，请重新下载");
    }
    return { ...index, directory, receipt };
  }
  async prepare(signal, progress = () => {}) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, ".download-lock");
    while (true) {
      signal.throwIfAborted();
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await readFile(join(lock, "pid"), "utf8").catch(() => "");
        if (owner) {
          try {
            process.kill(Number(owner), 0);
          } catch (error) {
            if (error.code === "ESRCH") {
              await rm(lock, { recursive: true, force: true });
              continue;
            }
          }
        }
        const entry = await stat(lock).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!entry) continue;
        if (Date.now() - entry.mtimeMs > 60000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
        await delay(250, undefined, { signal });
      }
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(lock, now, now).catch(() => {});
    }, 10000);
    let stage;
    try {
      await writeFile(join(lock, "pid"), String(process.pid), { mode: 0o600 });
      try {
        const installed = await this.installed();
        if (installed) {
          await this.verify(installed);
          return installed;
        }
      } catch (error) {
        if (!(
          error instanceof ModelIntegrityError ||
          error instanceof SyntaxError ||
          error.code === "ENOENT"
        ))
          throw error;
        await rm(join(this.directory, "installed.json"), { force: true });
      }
      progress({ stage: "catalog", received: 0, total: 0 });
      const components = await this.catalog(signal, this.request);
      const version = `${components.model.version}-${components.tokenizer.version}`;
      stage = await mkdtemp(join(this.directory, ".install-"));
      const total = components.model.size + components.tokenizer.size;
      let completed = 0;
      const hashes = {};
      for (const kind of ["model", "tokenizer"]) {
        const target = join(stage, kind === "model" ? "model" : "runtime");
        await mkdir(target, { recursive: true });
        const zip = await downloadArchive(
          components[kind],
          target,
          signal,
          (received) =>
            progress({
              stage: "downloading",
              received: completed + received,
              total,
            }),
          this.request,
        );
        signal.throwIfAborted();
        progress({
          stage: "extracting",
          received: completed + components[kind].size,
          total,
        });
        const files = await extractComponent(zip, target, kind);
        for (const [file, sha256] of Object.entries(files))
          hashes[`${kind === "model" ? "model" : "runtime"}/${file}`] = sha256;
        completed += components[kind].size;
      }
      progress({ stage: "runtime", received: completed, total });
      const runtime = await this.installRuntime(join(stage, "runtime"), signal);
      for (const [file, hash] of Object.entries(runtime))
        hashes[`runtime/${file}`] = hash;
      const files = {};
      for (const [file, sha256] of Object.entries(hashes))
        files[file] = { sha256, size: (await stat(join(stage, file))).size };
      await writeFile(
        join(stage, "ready.json"),
        JSON.stringify({ version, runtimeVersion, components, files }),
        { mode: 0o600 },
      );
      signal.throwIfAborted();
      const destination = join(this.directory, version);
      await rm(destination, { recursive: true, force: true });
      await rename(stage, destination);
      stage = null;
      await writeFile(
        join(this.directory, "installed.json.tmp"),
        JSON.stringify({ id: modelId, version }),
        { mode: 0o600 },
      );
      await rename(
        join(this.directory, "installed.json.tmp"),
        join(this.directory, "installed.json"),
      );
      return this.installed();
    } finally {
      clearInterval(heartbeat);
      if (stage) await rm(stage, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
  async verify(installed) {
    for (const [file, expected] of Object.entries(installed.receipt.files)) {
      const hash = createHash("sha256")
        .update(await readFile(join(installed.directory, file)))
        .digest("hex");
      if (hash !== expected.sha256)
        throw new ModelIntegrityError("模型文件校验失败，请重新下载");
    }
  }
}
