import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writePrivateFile } from "../src/private-file.mjs";

test("私有文件替换保持权限，失败保留原内容并清理临时文件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "private");
  const path = join(directory, "preferences.json");

  await writePrivateFile(path, '{"enabled":true}');
  await writePrivateFile(path, '{"enabled":false}');
  assert.equal(await readFile(path, "utf8"), '{"enabled":false}');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await assert.rejects(writePrivateFile(directory, "新偏好"));
  assert.equal(await readFile(path, "utf8"), '{"enabled":false}');
  assert.deepEqual(await readdir(root), ["private"]);
  assert.deepEqual(await readdir(directory), ["preferences.json"]);
});
