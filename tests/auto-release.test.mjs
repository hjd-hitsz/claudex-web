import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  changelogEntries,
  lastAutomaticReleaseWindow,
  patchReleaseNotes,
  planPatch,
  releaseWindow,
} from "../scripts/auto-release.mjs";

const manualRelease = {
  tag_name: "v4.3.0",
  published_at: "2026-11-28T02:45:11Z",
};
const incidentCheck = "2026-11-28T04:46:13Z";

test("最新正式版发布满两天即开放窗口，跨月补跑沿用同一起点", () => {
  for (const [time, open] of [
    [incidentCheck, false],
    ["2026-11-29T02:45:11Z", false],
    ["2026-11-30T02:44:11Z", false],
    ["2026-11-30T02:45:10Z", false],
    ["2026-11-30T02:45:11Z", true],
    ["2026-12-01T02:45:11Z", true],
    ["2026-12-07T02:45:11Z", true],
  ]) {
    assert.deepEqual(
      releaseWindow(manualRelease.published_at, Date.parse(time)),
      {
        start: "2026-11-28T02:45:11.000Z",
        eligibleAt: "2026-11-30T02:45:11.000Z",
        open,
      },
      time,
    );
  }
});

test("手动发布立即替换已经开放的窗口", () => {
  const now = Date.parse(incidentCheck);
  assert.equal(releaseWindow("2026-11-25T02:45:11Z", now).open, true);
  assert.equal(releaseWindow(manualRelease.published_at, now).open, false);
});

test("只从主线自动发布提交读取窗口 trailer，兼容旧提交与后续手动版本", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "claudex-web-auto-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  const commit = (date, ...messages) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=release@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        ...messages.flatMap((message) => ["-m", message]),
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    );
  git("init", "--quiet", "--initial-branch=main");
  commit("2026-11-22T05:00:00Z", "例行提交");
  assert.equal(lastAutomaticReleaseWindow(dir), null);
  commit("2026-11-23T05:00:00Z", "旧自动发布", "Claudex-Auto-Release: v4.2.1");
  assert.equal(lastAutomaticReleaseWindow(dir), null);
  commit(
    "2026-11-26T04:20:00Z",
    "跨窗口完成的自动发布",
    "Claudex-Auto-Release: v4.2.2\nClaudex-Auto-Release-Window: 2026-11-24T04:16:00.000Z",
  );
  commit("2026-11-26T05:00:00Z", "手动发布 v4.3.0");
  assert.equal(lastAutomaticReleaseWindow(dir), "2026-11-24T04:16:00.000Z");
});

test("自动发布跟随手动版本，只发布有新提交与未发布条目的 patch", () => {
  const fixture = {
    version: "4.1.5",
    latest: "4.1.5",
    head: "new",
    baseline: "released",
    entries: [{ text: "- 改进。" }],
    schedule: {},
    window: "2026-11-24T04:16:00.000Z",
    lastWindow: "2026-11-22T04:16:00.000Z",
  };
  assert.deepEqual(planPatch(fixture), { status: "prepare", tag: "v4.1.6" });
  assert.deepEqual(planPatch({ ...fixture, head: "released", window: null }), {
    status: "up-to-date",
  });
  assert.deepEqual(planPatch({ ...fixture, entries: [], window: null }), {
    status: "empty-changelog",
  });
  assert.deepEqual(planPatch({ ...fixture, version: "4.2.0" }), {
    status: "other-release",
  });
  assert.deepEqual(
    planPatch({ ...fixture, version: "4.2.0", latest: "4.2.0" }),
    { status: "prepare", tag: "v4.2.1" },
  );
  assert.deepEqual(
    planPatch({ ...fixture, schedule: { "v4.1.6": "2026-12-02T00:00:00Z" } }),
    { status: "scheduled-release" },
  );
  assert.deepEqual(planPatch({ ...fixture, window: null }), {
    status: "cooldown",
  });
});

test("同一窗口保留后续变更，并优先恢复尚未公开的自动版本", () => {
  const window = "2026-11-22T04:16:00.000Z";
  const sameWindow = {
    version: "4.2.1",
    latest: "4.2.1",
    head: "new",
    baseline: "released",
    entries: [{ text: "- 修复。" }],
    schedule: {},
    window,
    lastWindow: window,
  };
  assert.deepEqual(planPatch(sameWindow), { status: "window-complete" });
  assert.deepEqual(
    planPatch({ ...sameWindow, latest: "4.2.0", window: null }),
    {
      status: "other-release",
    },
  );
  assert.deepEqual(
    planPatch({ ...sameWindow, window: "2026-11-24T04:16:00.000Z" }),
    { status: "prepare", tag: "v4.2.2" },
  );
});

test("首次检查缺席后，真实提交与标签只推送一次，发布调用中断可恢复", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "claudex-web-auto-release-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "main");
  const remote = join(dir, "remote.git");
  const bin = join(dir, "bin");
  for (const path of [
    "main/docs/releases",
    "main/scripts",
    "main/server/src",
    "bin",
  ])
    mkdirSync(join(dir, path), { recursive: true });
  for (const path of [
    "scripts/auto-release.mjs",
    "scripts/npm-archive.mjs",
    "scripts/publish-release.mjs",
    "scripts/release-version.mjs",
    "scripts/version.mjs",
    "server/src/version.mjs",
  ])
    cpSync(new URL(`../${path}`, import.meta.url), join(project, path));

  const write = (path, content) => writeFileSync(join(project, path), content);
  const workspaces = ["client", "server", "packages/translation-engine"];
  const version = manualRelease.tag_name.slice(1);
  write("package.json", JSON.stringify({ version, workspaces }));
  for (const workspace of workspaces) {
    mkdirSync(join(project, workspace), { recursive: true });
    write(`${workspace}/package.json`, JSON.stringify({ version }));
  }
  write(
    "package-lock.json",
    JSON.stringify({
      version,
      packages: Object.fromEntries(
        ["", ...workspaces].map((path) => [path, { version }]),
      ),
    }),
  );
  const changelog = `## 未发布\n\n## [${version}] - 2026-11-28\n\n- 初始版本。\n`;
  write("CHANGELOG.md", changelog);
  for (const path of ["README.md", "docs/deployment.md"])
    write(path, "npm install -g @hjd-hitsz/claudex-web\n");

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--bare", "--quiet", remote);
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "初始版本");
  git("tag", manualRelease.tag_name);
  write(
    "CHANGELOG.md",
    changelog.replace("## 未发布\n", "## 未发布\n\n- 待发布修复。\n"),
  );
  git("commit", "-qam", "记录待发布修复");
  git("remote", "add", "origin", remote);
  git("push", "origin", "main", "--tags");

  const preload = join(dir, "runner.mjs");
  writeFileSync(
    preload,
    `Date.now = () => Date.parse(process.env.TEST_CHECKED_AT);
globalThis.fetch = async () => new Response();\n`,
  );
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "api repos/example/claudex-web/releases/latest")
    [ "$3" = "--jq" ] && [ "$4" = "{tag_name, published_at}" ] || exit 2
    printf '%s\\n' "$TEST_LATEST_RELEASE" ;;
  "run list") printf '[]\\n' ;;
  "workflow run")
    printf '%s\\n' "$*" >> "$TEST_DISPATCH_LOG"
    exit "$TEST_DISPATCH_EXIT" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const dispatches = join(dir, "dispatches");
  const run = (latest, { now, exit = 0, preview = false }) =>
    spawnSync(
      process.execPath,
      ["--import", preload, "scripts/auto-release.mjs"],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "example/claudex-web",
          PREVIEW: String(preview),
          TEST_CHECKED_AT: now,
          TEST_DISPATCH_LOG: dispatches,
          TEST_DISPATCH_EXIT: String(exit),
          TEST_LATEST_RELEASE: JSON.stringify(latest),
        },
      },
    );
  const missing = run(
    { tag_name: manualRelease.tag_name },
    { now: incidentCheck },
  );
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /"status":"missing-published-at"/);
  assert.match(missing.stdout, /最新正式版缺少有效的 published_at/);

  const cooling = run(manualRelease, { now: incidentCheck });
  assert.equal(cooling.status, 0, cooling.stderr);
  const coolingPlan = JSON.parse(cooling.stdout);
  assert.equal(coolingPlan.status, "cooldown");
  assert.equal(coolingPlan.checkedAt, "2026-11-28T04:46:13.000Z");
  assert.equal(coolingPlan.window, "2026-11-28T02:45:11.000Z");
  assert.equal(coolingPlan.eligibleAt, "2026-11-30T02:45:11.000Z");
  const eligible = run(manualRelease, {
    now: "2026-11-30T02:45:11Z",
    preview: true,
  });
  assert.equal(eligible.status, 0, eligible.stderr);
  assert.match(eligible.stdout, /"status":"prepare","tag":"v4.3.1"/);
  assert.equal(git("-C", remote, "tag", "--list"), "v4.3.0");

  const retryTime = "2026-12-01T02:45:11Z";
  const interrupted = run(manualRelease, { now: retryTime, exit: 1 });
  assert.equal(interrupted.status, 1, interrupted.stderr);
  assert.match(interrupted.stdout, /"status":"prepare","tag":"v4.3.1"/);
  const preparedCommit = git("rev-parse", "v4.3.1^{commit}");
  assert.equal(git("-C", remote, "rev-parse", "main"), preparedCommit);
  assert.equal(lastAutomaticReleaseWindow(project), "2026-11-28T02:45:11.000Z");

  const resumed = run(manualRelease, { now: retryTime });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /"status":"other-release"/);
  assert.equal(git("-C", remote, "rev-parse", "main"), preparedCommit);

  write(
    "CHANGELOG.md",
    readFileSync(join(project, "CHANGELOG.md"), "utf8").replace(
      "### 新增\n",
      "### 新增\n\n- 后续新功能。\n",
    ),
  );
  git("commit", "-qam", "记录后续功能");
  git("push", "origin", "HEAD:refs/heads/main");
  const autoRelease = {
    tag_name: "v4.3.1",
    published_at: "2026-12-01T02:50:00Z",
  };
  const repeated = run(autoRelease, { now: "2026-12-01T03:16:00Z" });
  assert.equal(repeated.status, 0, repeated.stderr);
  const repeatedPlan = JSON.parse(repeated.stdout);
  assert.equal(repeatedPlan.status, "cooldown");
  assert.equal(repeatedPlan.window, "2026-12-01T02:50:00.000Z");
  assert.equal(repeatedPlan.eligibleAt, "2026-12-03T02:50:00.000Z");
  assert.equal(repeatedPlan.lastWindow, coolingPlan.window);
  assert.equal(git("-C", remote, "tag", "--list"), "v4.3.0\nv4.3.1");
  assert.equal(
    readFileSync(dispatches, "utf8"),
    "workflow run release.yml --ref v4.3.1\n".repeat(2),
  );
});

test("发布说明保留未发布条目及原始行号，附上来源提交", () => {
  const markdown = `# 变更日志

## 未发布

### 改进

- 新的设置。
  保留已有偏好。

### 修复

- 继续显示对话。

## [4.1.5] - 2026-11-20

- 已发布的条目。
`;
  const entries = changelogEntries(markdown);
  assert.deepEqual(entries, [
    { line: 7, text: "- 新的设置。\n  保留已有偏好。" },
    { line: 12, text: "- 继续显示对话。" },
  ]);
  const commits = new Map([
    [7, "a".repeat(40)],
    [12, "b".repeat(40)],
  ]);
  const notes = patchReleaseNotes(
    "example/claudex-web",
    "v4.1.6",
    entries,
    (line) => commits.get(line),
  );
  assert.equal(
    notes,
    `# Claudex Web v4.1.6

- 新的设置。
  保留已有偏好。（[aaaaaaa](https://github.com/example/claudex-web/commit/${commits.get(7)})）
- 继续显示对话。（[bbbbbbb](https://github.com/example/claudex-web/commit/${commits.get(12)})）
`,
  );
});
