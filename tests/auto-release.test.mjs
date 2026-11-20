import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changelogEntries,
  patchReleaseNotes,
  planPatch,
  releaseCheckDue,
} from "../scripts/auto-release.mjs";

test("两天的检查周期跨月延续，起点前与间隔日跳过", () => {
  for (const [time, expected] of [
    ["2026-11-22T04:15:59Z", false],
    ["2026-11-22T04:16:00Z", true],
    ["2026-11-23T04:16:00Z", false],
    ["2026-11-24T04:30:00Z", true],
    ["2026-11-30T04:20:00Z", true],
    ["2026-12-01T04:20:00Z", false],
    ["2026-12-02T04:20:00Z", true],
  ]) {
    assert.equal(releaseCheckDue(Date.parse(time)), expected, time);
  }
});

test("自动发布跟随手动版本，只发布有新提交与未发布条目的 patch", () => {
  const fixture = {
    version: "4.1.5",
    latest: "4.1.5",
    head: "new",
    baseline: "released",
    entries: [{ text: "- 改进。" }],
    schedule: {},
  };
  assert.deepEqual(planPatch(fixture), { status: "prepare", tag: "v4.1.6" });
  assert.deepEqual(planPatch({ ...fixture, head: "released" }), {
    status: "up-to-date",
  });
  assert.deepEqual(planPatch({ ...fixture, entries: [] }), {
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
