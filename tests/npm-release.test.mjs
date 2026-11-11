import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  npmReleaseReady,
  verifyNpmIntegrity,
  selectNpmReleases,
} from "../scripts/publish-npm.mjs";

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
