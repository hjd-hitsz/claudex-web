import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmPackageName } from "./npm-archive.mjs";
import { readReleaseSchedule, releaseNotesBody } from "./publish-release.mjs";
import { checkRelease, checkVersions, prepareVersion } from "./version.mjs";

const releaseInterval = 2 * 24 * 60 * 60 * 1000;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const trailer = "Claudex-Auto-Release";
const windowTrailer = "Claudex-Auto-Release-Window";
const run = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
const git = (...args) => run("git", args);
const gh = (...args) => run("gh", args);

export function releaseWindow(publishedAt, now) {
  const start = Date.parse(publishedAt);
  if (!Number.isFinite(start)) return null;
  const eligibleAt = start + releaseInterval;
  return {
    start: new Date(start).toISOString(),
    eligibleAt: new Date(eligibleAt).toISOString(),
    open: now >= eligibleAt,
  };
}

export function lastAutomaticReleaseWindow(dir) {
  return (
    git(
      "-C",
      dir,
      "log",
      "-1",
      "--first-parent",
      `--grep=^${trailer}:`,
      `--format=%(trailers:key=${windowTrailer},valueonly)`,
      "HEAD",
    ) || null
  );
}

export function changelogEntries(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^## 未发布\s*$/.test(line));
  assert.ok(start >= 0, "CHANGELOG.md 缺少未发布段");
  const entries = [];
  let entry;
  for (
    let index = start + 1;
    index < lines.length && !lines[index].startsWith("## ");
    index++
  ) {
    const line = lines[index];
    if (/^- \S/.test(line)) {
      entry = { line: index + 1, text: line };
      entries.push(entry);
    } else if (line.startsWith("### ")) {
      entry = undefined;
    } else if (entry) {
      entry.text += "\n" + line;
    }
  }
  return entries.map((entry) => ({ ...entry, text: entry.text.trimEnd() }));
}

export function planPatch({
  version,
  latest,
  head,
  baseline,
  entries,
  schedule,
  window,
  lastWindow,
}) {
  const parts = latest.match(stableVersion);
  assert.ok(parts, "最新正式版必须使用稳定版本");
  if (latest !== version) return { status: "other-release" };
  if (head === baseline) return { status: "up-to-date" };
  if (!entries.length) return { status: "empty-changelog" };
  if (!window) return { status: "cooldown" };
  if (lastWindow === window) return { status: "window-complete" };
  const [, major, minor, patch] = parts;
  const tag = `v${major}.${minor}.${BigInt(patch) + 1n}`;
  return Object.hasOwn(schedule, tag)
    ? { status: "scheduled-release" }
    : { status: "prepare", tag };
}

export function patchReleaseNotes(repo, tag, entries, sourceCommit) {
  const list = entries.map(({ line, text }) => {
    const commit = sourceCommit(line);
    assert.match(commit, /^[a-f0-9]{40}$/);
    return `${text}（[${commit.slice(0, 7)}](https://github.com/${repo}/commit/${commit})）`;
  });
  const markdown = `# Claudex Web ${tag}\n\n${list.join("\n")}\n`;
  releaseNotesBody(markdown, tag);
  return markdown;
}

function automaticCommit(tag) {
  if (!git("tag", "--list", tag)) return;
  const commit = git("rev-parse", `${tag}^{commit}`);
  const marker = git(
    "log",
    "-1",
    `--format=%(trailers:key=${trailer},valueonly)`,
    commit,
  );
  if (marker === tag) {
    git("merge-base", "--is-ancestor", commit, "HEAD");
    return commit;
  }
}

function workflowRuns(workflow, commit, tag) {
  const args = [
    "run",
    "list",
    "--workflow",
    workflow,
    "--commit",
    commit,
    "--json",
    "databaseId,status,conclusion,url,event",
  ];
  if (tag) args.push("--branch", tag);
  return JSON.parse(gh(...args));
}

function publishTag(tag, commit) {
  const [previous] = workflowRuns("release.yml", commit, tag);
  if (previous) {
    console.log(`${tag} 发布工作流 ${previous.status} ${previous.url}`);
    if (previous.status === "completed" && previous.conclusion !== "success")
      gh("run", "rerun", String(previous.databaseId), "--failed");
    return;
  }
  console.log(gh("workflow", "run", "release.yml", "--ref", tag));
}

async function npmAvailable(tag) {
  const registry = "https://registry.npmjs.org";
  const response = await fetch(
    `${registry}/${encodeURIComponent(npmPackageName)}/${tag.slice(1)}`,
    {
      signal: AbortSignal.timeout(30000),
    },
  );
  if (response.status === 404) return false;
  assert.ok(response.ok, `npm 版本查询失败，HTTP ${response.status}`);
  return true;
}

function retryNpm(tag) {
  const commit = automaticCommit(tag);
  if (!commit) return;
  if (
    workflowRuns("npm-publish.yml", commit).some(
      (run) => run.status !== "completed",
    )
  )
    return;
  console.log(
    gh(
      "workflow",
      "run",
      "npm-publish.yml",
      "--ref",
      "main",
      "-f",
      `tag=${tag}`,
    ),
  );
}

function preparePatch(repo, head, tag, entries, window) {
  const notes = patchReleaseNotes(
    repo,
    tag,
    entries,
    (line) =>
      git(
        "blame",
        "-l",
        "-L",
        `${line},${line}`,
        head,
        "--",
        "CHANGELOG.md",
      ).split(/\s/)[0],
  );
  prepareVersion(process.cwd(), tag.slice(1));
  const notesPath = `docs/releases/${tag}.md`;
  writeFileSync(notesPath, notes);
  execFileSync("npm", ["ci"], { stdio: "inherit" });
  execFileSync("npm", ["exec", "--", "prettier", "--write", notesPath], {
    stdio: "inherit",
  });
  execFileSync("npm", ["run", "check"], {
    stdio: "inherit",
    env: { ...process.env, GITHUB_REF_NAME: tag },
  });

  git("diff", "--check");
  git(
    "add",
    "CHANGELOG.md",
    "README.md",
    "docs/deployment.md",
    notesPath,
    "package.json",
    "package-lock.json",
    "client/package.json",
    "server/package.json",
    "packages/translation-engine/package.json",
  );
  git(
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "-m",
    `chore(release): 准备 ${tag} 发布`,
    "-m",
    "- 同步正式版与部署示例，将未发布变更归档并生成发布说明。",
    "-m",
    `${trailer}: ${tag}\n${windowTrailer}: ${window}`,
  );
  git(
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "tag",
    "-a",
    tag,
    "-m",
    `Claudex Web ${tag}`,
  );
  checkRelease(process.cwd(), tag);
  return git("rev-parse", "HEAD");
}

function latestStableRelease(repo) {
  return JSON.parse(
    gh(
      "api",
      `repos/${repo}/releases/latest`,
      "--jq",
      "{tag_name, published_at}",
    ),
  );
}

async function main({ repo, preview }) {
  assert.ok(repo, "需要 GITHUB_REPOSITORY");
  assert.equal(git("status", "--porcelain"), "", "自动发布需要干净检出");
  git("fetch", "origin", "main", "--tags");
  git("checkout", "--detach", "origin/main");
  const release = latestStableRelease(repo);
  const { tag_name: latestTag, published_at: publishedAt } = release;
  assert.match(latestTag, /^v/);
  const now = Date.now();
  const checkedAt = new Date(now).toISOString();
  const window = releaseWindow(publishedAt, now);
  if (!window) {
    console.log(
      JSON.stringify({
        latest: latestTag,
        checkedAt,
        status: "missing-published-at",
        reason: "最新正式版缺少有效的 published_at，跳过自动发布",
      }),
    );
    return;
  }
  const latest = latestTag.slice(1);
  const baseline = git("rev-parse", `${latestTag}^{commit}`);
  git("merge-base", "--is-ancestor", baseline, "HEAD");
  const head = git("rev-parse", "HEAD");
  const version = checkVersions();
  const schedule = readReleaseSchedule();
  const entries = changelogEntries(readFileSync("CHANGELOG.md", "utf8"));
  const lastWindow = lastAutomaticReleaseWindow(process.cwd());
  const plan = planPatch({
    version,
    latest,
    head,
    baseline,
    entries,
    schedule,
    window: window.open ? window.start : null,
    lastWindow,
  });
  console.log(
    JSON.stringify({
      latest: latestTag,
      baseline,
      head,
      entries: entries.length,
      checkedAt,
      window: window.start,
      eligibleAt: window.eligibleAt,
      lastWindow,
      ...plan,
    }),
  );
  if (preview) {
    git("push", "--dry-run", "origin", "HEAD:refs/heads/main");
    return;
  }
  if (plan.status === "other-release") {
    const tag = `v${version}`;
    if (!Object.hasOwn(schedule, tag)) {
      const commit = automaticCommit(tag);
      if (commit) publishTag(tag, commit);
    }
    return;
  }
  if (!(await npmAvailable(latestTag))) {
    retryNpm(latestTag);
    return;
  }
  if (plan.status !== "prepare" || git("tag", "--list", plan.tag)) return;
  const commit = preparePatch(repo, head, plan.tag, entries, window.start);
  assert.deepEqual(
    latestStableRelease(repo),
    release,
    "最新正式版或其发布时间已变化，下一次检查将重新计算",
  );
  assert.equal(
    git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0],
    head,
    "远端 main 已更新，下一次检查将重新计算",
  );
  git(
    "push",
    "--atomic",
    "origin",
    "HEAD:refs/heads/main",
    `refs/tags/${plan.tag}`,
  );
  publishTag(plan.tag, commit);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main({
    repo: process.env.GITHUB_REPOSITORY,
    preview: process.env.PREVIEW === "true",
  });
