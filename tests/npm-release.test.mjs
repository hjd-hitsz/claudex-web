import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  npmPackageName,
  prepareNpmArchive,
  verifyArchiveContents,
} from "../scripts/npm-archive.mjs";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  npmReleaseReady,
  verifyNpmIntegrity,
  selectNpmReleases,
} from "../scripts/publish-npm.mjs";

test("旧名称附件迁移作用域后保留编译字节，多次打包保持一致", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "claudex-npm-archive-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "package");
  mkdirSync(source);
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "claudex-web",
      version: "4.0.1",
      files: ["app.js"],
      scripts: { prepack: "exit 1" },
    }),
  );
  writeFileSync(join(source, "app.js"), "compiled output\n");
  writeFileSync(
    join(source, "README.md"),
    "npm install -g claudex-web\nnpm install -g @openai/codex\n",
  );
  const original = join(dir, "original.tgz");
  execFileSync("tar", ["-czf", original, "-C", dir, "package"]);
  const outputs = ["first", "second"].map((name) => {
    const outputDir = join(dir, name);
    mkdirSync(outputDir);
    return prepareNpmArchive(original, outputDir);
  });
  assert.deepEqual(readFileSync(outputs[0]), readFileSync(outputs[1]));
  const recompressed = join(dir, "recompressed.tgz");
  writeFileSync(
    recompressed,
    gzipSync(gunzipSync(readFileSync(outputs[0])), { level: 1 }),
  );
  verifyArchiveContents(outputs[0], recompressed);
  assert.throws(
    () => verifyArchiveContents(outputs[0], original),
    /内容不一致/,
  );
  const extract = (file) =>
    execFileSync("tar", ["-xOf", outputs[0], `package/${file}`], {
      encoding: "utf8",
    });
  assert.equal(extract("app.js"), "compiled output\n");
  assert.equal(JSON.parse(extract("package.json")).name, npmPackageName);
  assert.equal(
    extract("README.md"),
    `npm install -g ${npmPackageName}\nnpm install -g @openai/codex\n`,
  );
  assert.equal(prepareNpmArchive(outputs[0], dir), outputs[0]);
});

test("标签工作流按提交选公开版本，定时工作流只处理计划内公开版本", () => {
  const releases = [
    { tag_name: "v4.0.0", draft: false },
    { tag_name: "v4.0.1", draft: false },
    { tag_name: "v4.0.2", draft: true },
  ];
  const sha = "a".repeat(40);
  const commit = (tag) => (tag === "v4.0.1" ? sha : "b".repeat(40));
  assert.deepEqual(
    selectNpmReleases(releases, {}, { SOURCE_COMMIT: sha }, commit),
    [releases[1]],
  );
  assert.deepEqual(
    selectNpmReleases(
      releases,
      { "v4.0.1": "2020-01-01T00:00:00Z" },
      { SOURCE_WORKFLOW: "Publish scheduled releases" },
      commit,
    ),
    [releases[1]],
  );
  assert.deepEqual(
    selectNpmReleases(
      releases,
      {},
      { SOURCE_WORKFLOW: "Publish scheduled releases" },
      commit,
    ),
    [],
  );
  assert.deepEqual(
    selectNpmReleases(releases, {}, { RELEASE_TAG: "v4.0.0" }, commit),
    [releases[0]],
  );
  assert.throws(
    () => selectNpmReleases(releases, {}, { RELEASE_TAG: "v4.0.2" }),
    /草稿/,
  );
  assert.throws(
    () => selectNpmReleases(releases, {}, { RELEASE_TAG: "v9.0.0" }),
    /尚未创建/,
  );
});

test("npm 发布等待 GitHub 公开与含时区的计划时间，手动重试遵守同一条件", () => {
  const release = { tag_name: "v4.0.1", draft: false };
  const date = "2026-11-12T09:00:00+08:00";
  const schedule = { "v4.0.1": date };
  const due = Date.parse(date);
  assert.equal(npmReleaseReady(release, schedule, due - 1), false);
  assert.equal(npmReleaseReady(release, schedule, due), true);
  assert.equal(
    npmReleaseReady({ ...release, draft: true }, schedule, due),
    false,
  );
  assert.equal(npmReleaseReady(release, {}, due - 1), true);
  assert.throws(() => npmReleaseReady({ tag_name: "vbad" }, {}));
});

test("npm 同版本重试校验原始附件，拒绝缺少完整性或内容已改变的版本", () => {
  const bytes = Buffer.from("original release archive");
  const dist = {
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  verifyNpmIntegrity(dist, bytes);
  assert.throws(
    () => verifyNpmIntegrity(dist, Buffer.from("changed archive")),
    /不一致/,
  );
  assert.throws(() => verifyNpmIntegrity({}, bytes), /不一致/);
});
