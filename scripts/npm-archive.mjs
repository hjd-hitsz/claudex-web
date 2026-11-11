import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const npmPackageName = "@hjd-hitsz/claudex-web";

// 已发布的旧名称附件保留编译内容，仅迁移 npm 包身份与安装说明。
export function prepareNpmArchive(path, dir) {
  const run = (args) => execFileSync("tar", args, { encoding: "utf8" });
  const manifest = JSON.parse(run(["-xOf", path, "package/package.json"]));
  if (manifest.name === npmPackageName) return path;
  assert.equal(manifest.name, "claudex-web", "发行包名称无法迁移到当前 npm 包");
  const extracted = join(dir, "scoped");
  mkdirSync(extracted);
  run(["-xzf", path, "-C", extracted]);
  manifest.name = npmPackageName;
  manifest.repository = {
    type: "git",
    url: "git+https://github.com/hjd-hitsz/claudex-web.git",
  };
  const packageDir = join(extracted, "package");
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const readme = join(packageDir, "README.md");
  writeFileSync(
    readme,
    readFileSync(readme, "utf8").replace(
      /^npm install -g .*claudex-web.*$/gm,
      `npm install -g ${npmPackageName}`,
    ),
  );
  const [pack] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        packageDir,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        dir,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  return join(dir, pack.filename);
}
