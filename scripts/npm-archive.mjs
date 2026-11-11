import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const npmPackageName = "@hjd-hitsz/claudex-web";

// 旧包名迁移可由不同 Node.js 环境压缩，按文件路径和字节核对实际发行内容。
export function verifyArchiveContents(expected, actual) {
  const tar = (args, encoding) =>
    execFileSync("tar", args, { encoding, maxBuffer: 32 * 1024 * 1024 });
  const files = (path) =>
    tar(["-tzf", path], "utf8")
      .trim()
      .split("\n")
      .filter((name) => !name.endsWith("/"))
      .sort();
  for (const path of [expected, actual])
    assert.ok(
      tar(["-tvzf", path], "utf8")
        .trim()
        .split("\n")
        .every((line) => /^[d-]/.test(line)),
      "发行包只允许普通文件和目录",
    );
  const names = files(expected);
  assert.deepEqual(
    files(actual),
    names,
    "npm 安装包的文件清单与发行内容不一致",
  );
  for (const name of names)
    assert.deepEqual(
      tar(["-xOf", actual, "--", name]),
      tar(["-xOf", expected, "--", name]),
      `npm 安装包文件内容不一致：${name}`,
    );
}

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
  const packed = JSON.parse(
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
  // npm 11 返回数组，npm 12 按包名组织打包结果。
  const [pack] = Array.isArray(packed) ? packed : Object.values(packed);
  return join(dir, pack.filename);
}
