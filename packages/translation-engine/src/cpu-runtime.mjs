import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  link,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
const execute = promisify(execFile);
export const runtimeVersion = "1.30.0";

export async function installCpuRuntime(directory, signal) {
  const temporary = await mkdtemp(join(directory, ".cpu-runtime-"));
  const hashes = {};
  try {
    for (const name of ["onnxruntime-node", "onnxruntime-common"]) {
      const { stdout } = await execute(
        "npm",
        [
          "pack",
          `${name}@${runtimeVersion}`,
          "--ignore-scripts",
          "--prefer-offline",
          "--json",
          "--pack-destination",
          temporary,
        ],
        { signal, maxBuffer: 1024 * 1024 },
      );
      const [pack] = JSON.parse(stdout);
      const archive = join(temporary, pack.filename);
      const files = pack.files
        .map((file) => file.path)
        .filter(
          (file) =>
            file === "package.json" ||
            /(^|\/)(LICENSE|ThirdPartyNotices.txt|README.md)$/.test(file) ||
            (name === "onnxruntime-node"
              ? /^dist\/.*\.js$/.test(file) ||
                /^bin\/napi-v6\/linux\/x64\/(onnxruntime_binding.node|libonnxruntime.so.1)$/.test(
                  file,
                )
              : /^dist\/cjs\/.*\.(js|json)$/.test(file)),
        );
      const target = join(directory, "node_modules", name);
      await mkdir(target, { recursive: true });
      await execute(
        "tar",
        [
          "-xzf",
          archive,
          "--strip-components=1",
          "-C",
          target,
          ...files.map((file) => `package/${file}`),
        ],
        { signal },
      );
      for (const file of files)
        hashes[`node_modules/${name}/${file}`] = createHash("sha256")
          .update(await readFile(join(target, file)))
          .digest("hex");
    }
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true }),
      { mode: 0o600 },
    );
    hashes["package.json"] = createHash("sha256")
      .update(await readFile(join(directory, "package.json")))
      .digest("hex");
    await link(
      join(
        directory,
        "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
      ),
      join(directory, "libonnxruntime.so"),
    );
    hashes["libonnxruntime.so"] = createHash("sha256")
      .update(await readFile(join(directory, "libonnxruntime.so")))
      .digest("hex");
    return hashes;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
