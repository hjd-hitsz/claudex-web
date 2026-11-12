import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const setup = fileURLToPath(
  new URL("./helpers/test-console.mjs", import.meta.url),
);
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;

test("公共测试入口隔离模块加载、并发执行和清理阶段的 Unicode 日志", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-test-console-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = [join(directory, "first.mjs"), join(directory, "second.mjs")];
  const source = `
import test, { after } from "node:test";
import assert from "node:assert/strict";
console.info("模块加载 🟡 café");
test("并发日志完整保留", async () => {
  const stdout = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    assert.notEqual(typeof chunk, "string", "控制台日志写入了测试事件通道");
    return stdout.call(this, chunk, ...args);
  };
  try {
    for (let index = 0; index < 30; index++) {
      for (const method of ["log", "info", "debug", "warn", "error"])
        console[method]("诊断 %s %d", "中文 🚀", index, { backend: "claude" });
      await new Promise((resolve) => setImmediate(resolve));
    }
    console.dir({ message: "对象诊断 🧪" });
    console.trace("调用栈诊断");
    console.assert(false, "控制台断言诊断");
  } finally {
    process.stdout.write = stdout;
  }
  assert.equal(1, 1);
});
after(() => console.log("清理完成 ✅"));
`;
  await Promise.all(paths.map((path) => writeFile(path, source)));
  for (let iteration = 0; iteration < 10; iteration++) {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--import",
        setup,
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=2",
        ...paths,
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024, env: environment },
    );
    assert.match(stdout, /# tests 2\n/);
    assert.match(stdout, /# pass 2\n/);
    assert.match(stdout, /# fail 0\n/);
    assert.equal(stderr, "");
    for (const marker of [
      "模块加载 🟡 café",
      "诊断 中文 🚀 29 { backend: 'claude' }",
      "对象诊断 🧪",
      "调用栈诊断",
      "控制台断言诊断",
      "清理完成 ✅",
    ])
      assert(stdout.includes(marker), marker);
    assert(!stdout.includes("Unable to deserialize"));
  }
});

test("日志隔离保留真实断言失败和非零退出状态，并接入所有 npm 测试入口", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claudex-test-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "failure.mjs");
  await writeFile(
    path,
    `import test from "node:test";
import assert from "node:assert/strict";
test("真实断言失败", () => {
  console.error("失败诊断 🔴");
  assert.equal(1, 2);
});
`,
  );
  await assert.rejects(
    run(
      process.execPath,
      ["--import", setup, "--test", "--test-reporter=tap", path],
      {
        timeout: 10000,
        env: environment,
      },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /ERR_ASSERTION/);
      assert.match(error.stdout, /失败诊断 🔴/);
      assert.match(error.stdout, /# tests 1\n/);
      assert.match(error.stdout, /# fail 1\n/);
      assert(!error.stdout.includes("Unable to deserialize"));
      return true;
    },
  );
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["test:unit", "test:package"])
    assert(scripts[name].includes("--import ./tests/helpers/test-console.mjs"));
});
