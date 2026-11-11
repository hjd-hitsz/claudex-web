import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { readReleaseSchedule } from "./publish-release.mjs";
import { releaseVersion } from "./release-version.mjs";

const registry = "https://registry.npmjs.org";
const run = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export function npmReleaseReady(release, schedule, now = Date.now()) {
  assert.match(release.tag_name, /^v/);
  assert.match(release.tag_name.slice(1), releaseVersion);
  const publishAt = schedule[release.tag_name];
  return !release.draft && (!publishAt || now >= Date.parse(publishAt));
}

export function verifyNpmIntegrity(dist, bytes) {
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(
    dist.integrity,
    integrity,
    "npm 同版本内容与 GitHub 发行附件不一致",
  );
}

async function lookup(version) {
  const response = await fetch(`${registry}/claudex-web/${version}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  assert.ok(response.ok, `npm 版本查询失败，HTTP ${response.status}`);
  return response.json();
}

async function publish(repo, release) {
  const tag = release.tag_name;
  const version = tag.slice(1);
  const dir = mkdtempSync(join(tmpdir(), "claudex-web-npm-"));
  try {
    const filename = `claudex-web-${version}.tgz`;
    run("gh", [
      "release",
      "download",
      tag,
      "--repo",
      repo,
      "--dir",
      dir,
      "--pattern",
      filename,
      "--pattern",
      `${filename}.sha256`,
    ]);
    const path = join(dir, filename);
    const bytes = readFileSync(path);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      readFileSync(`${path}.sha256`, "utf8").trim(),
      `${checksum}  ${filename}`,
    );
    const manifest = JSON.parse(
      run("tar", ["-xOf", path, "package/package.json"]),
    );
    assert.equal(manifest.name, "claudex-web");
    assert.equal(manifest.version, version);
    const build = JSON.parse(
      run("tar", ["-xOf", path, "package/build-info.json"]),
    );
    assert.equal(build.version, version);
    assert.equal(
      build.revision,
      run("git", ["rev-parse", `${tag}^{commit}`]).trim(),
    );
    assert.equal(build.dirty, false);
    assert.equal(build.channel, "release");
    const existing = await lookup(version);
    if (existing) {
      verifyNpmIntegrity(existing.dist, bytes);
      console.log(`${tag} 已在 npm 发布，原始附件完整性一致`);
      return;
    }
    const prefix = join(dir, "install");
    run("npm", [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      path,
    ]);
    const installed = JSON.parse(
      run(join(prefix, "bin/claudex-web"), ["version", "--json"]),
    );
    assert.deepEqual(installed, build);
    // 稳定版与预发布版分别更新 latest 与 next 分发标签。
    run("npm", [
      "publish",
      path,
      "--access",
      "public",
      "--tag",
      version.includes("-") ? "next" : "latest",
      "--registry",
      registry,
      // 历史发行包可能缺少生成来源证明所需的 repository 字段。
      ...(manifest.repository?.url ? [] : ["--provenance=false"]),
    ]);
    for (let attempt = 0; attempt < 60; attempt++) {
      const published = await lookup(version);
      if (published) {
        verifyNpmIntegrity(published.dist, bytes);
        const response = await fetch(published.dist.tarball, {
          signal: AbortSignal.timeout(30000),
        });
        assert.ok(response.ok, `npm 安装包下载失败，HTTP ${response.status}`);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
        console.log(`${tag} npm 发布、公开下载和原始附件一致性验证通过`);
        return;
      }
      await setTimeout(15000);
    }
    throw new Error(`${tag} 已提交 npm，等待公开超时，请重试核对同版本`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function selectNpmReleases(
  releases,
  schedule,
  event,
  resolveCommit = (tag) => run("git", ["rev-parse", `${tag}^{commit}`]).trim(),
) {
  let selected;
  if (event.RELEASE_TAG) {
    const release = releases.find(
      (item) => item.tag_name === event.RELEASE_TAG,
    );
    assert.ok(release, "指定版本的 GitHub Release 尚未创建");
    assert.ok(
      npmReleaseReady(release, schedule),
      "指定版本仍为草稿或尚未到发布时间",
    );
    selected = [release];
  } else if (event.SOURCE_WORKFLOW === "Publish scheduled releases") {
    selected = releases.filter(
      (release) =>
        Object.hasOwn(schedule, release.tag_name) &&
        npmReleaseReady(release, schedule),
    );
  } else {
    const commit = event.SOURCE_COMMIT;
    assert.match(commit || "", /^[a-f0-9]{40}$/);
    selected = releases.filter(
      (release) =>
        !release.draft &&
        releaseVersion.test(release.tag_name.slice(1)) &&
        resolveCommit(release.tag_name) === commit &&
        npmReleaseReady(release, schedule),
    );
  }
  return selected;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  assert.ok(repo, "发布需要 GITHUB_REPOSITORY");
  const schedule = readReleaseSchedule();
  const releases = JSON.parse(
    run("gh", [
      "api",
      `repos/${repo}/releases?per_page=100`,
      "--paginate",
      "--slurp",
    ]),
  ).flat();
  const selected = selectNpmReleases(releases, schedule, process.env);
  for (const release of selected) await publish(repo, release);
  if (!selected.length) console.log("本次工作流没有已到期的公开发行包");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
