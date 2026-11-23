import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodeLineSearch } from "../src/workspace/code-line-search.mjs";

test("整行匹配仅返回至多三个真实候选文件", async (t) => {
  if (spawnSync("rg", ["--version"]).error?.code === "ENOENT")
    return t.skip("需要 ripgrep");
  const cwd = await mkdtemp(join(tmpdir(), "claudex-code-lines-"));
  const search = createCodeLineSearch();
  t.after(async () => {
    search.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const line = "    result = inputs[0] + 1";
  const put = (file, text) => writeFile(join(cwd, file), text);
  const query = () => search.search({ cwd, line });
  await put(".gitignore", "ignored.py\n");
  await put("ignored.py", line);
  await put("partial.py", "prefix " + line);
  await put("one.py", "header\r\n" + line + "\r\n" + line);
  await symlink("one.py", join(cwd, "alias.py"));
  assert.deepEqual(await query(), {
    matches: [{ path: join(cwd, "one.py"), line: 2 }],
  });
  await put("two.py", line);
  await put("three.py", line + "\n");
  assert.equal((await query()).matches.length, 3);
  await put("four.py", line);
  assert.deepEqual(await query(), { matches: [] });
  assert.deepEqual(await search.search({ cwd, line: "result" }), {
    matches: [],
  });
  assert.throws(() => search.search({ cwd, line: "\none" }), /有效代码片段/);
});

test("多行候选验证完整相邻的行并返回片段起始行", async (t) => {
  if (spawnSync("rg", ["--version"]).error?.code === "ENOENT")
    return t.skip("需要 ripgrep");
  const cwd = await mkdtemp(join(tmpdir(), "claudex-code-snippet-"));
  const search = createCodeLineSearch();
  t.after(async () => {
    search.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const lines = [
    "class Costs:",
    "    def __init__(self):",
    "        self.costs = np.array([0.0])",
  ];
  const line = lines.join("\n");
  const put = (name, text) => writeFile(join(cwd, name), text);
  await put(
    "class.py",
    "header\r\n" + lines[2] + "\r\n\r\n" + lines.join("\r\n") + "\r\n",
  );
  await put("mirror.py", line + "\n" + line);
  await put("split.py", lines.join("\n\n"));
  await put("partial.py", line + " + 1");
  await put("similar.py", line.replace("0.0", "1.0"));
  assert.deepEqual(await search.search({ cwd, line }), {
    matches: [
      { path: join(cwd, "class.py"), line: 4 },
      { path: join(cwd, "mirror.py"), line: 1 },
    ],
  });
  await put("third.py", line);
  await put("fourth.py", line);
  assert.deepEqual(await search.search({ cwd, line }), { matches: [] });
});

test("多行选区匹配首行后缀及末行前缀，内部各行连续且完整", async (t) => {
  if (spawnSync("rg", ["--version"]).error?.code === "ENOENT")
    return t.skip("需要 ripgrep");
  const cwd = await mkdtemp(join(tmpdir(), "claudex-code-selection-"));
  const search = createCodeLineSearch();
  t.after(async () => {
    search.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const lines = [
    "    def calculate_total_from_selection(",
    "        读数,",
    "        超过上限返回默认值",
    "    ):  # 保留的注释",
  ];
  const selection = [
    "calculate_total_from_selection(",
    ...lines.slice(1, -1),
    "    ):",
  ].join("\n");
  const put = (name, text) => writeFile(join(cwd, name), text);
  await put(
    "原始文件.py",
    Buffer.from("\ufeff\r\n" + lines.join("\r\n"), "utf16le"),
  );
  await put(
    "wrong-head.py",
    [lines[0] + "extra", ...lines.slice(1)].join("\n"),
  );
  await put(
    "wrong-tail.py",
    [...lines.slice(0, -1), "x" + lines[3]].join("\n"),
  );
  await put(
    "wrong-body.py",
    [lines[0], lines[1], "", ...lines.slice(2)].join("\n"),
  );
  const query = () => search.search({ cwd, line: selection });
  assert.deepEqual(await query(), {
    matches: [{ path: join(cwd, "原始文件.py"), line: 2 }],
  });
  for (const name of ["one.py", "two.py", "three.py"])
    await put(name, lines.join("\n"));
  assert.deepEqual(await query(), { matches: [] });
  await put("exact.py", selection);
  assert.deepEqual(await query(), {
    matches: [{ path: join(cwd, "exact.py"), line: 1 }],
  });
  assert.deepEqual(await search.search({ cwd, line: "value):\n    return" }), {
    matches: [],
  });
  await put("two-lines.py", "def sum_values(value):\n    return value + 1");
  assert.deepEqual(await search.search({ cwd, line: "value):\n    return" }), {
    matches: [{ path: join(cwd, "two-lines.py"), line: 1 }],
  });
});

test("内存映射收到 SIGBUS 后用缓冲读取，舍弃已输出的候选", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "claudex-code-mmap-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = join(cwd, "bin");
  await mkdir(bin);
  const selection = "def report():\n    return total";
  await Promise.all([
    writeFile(join(cwd, "interrupted.py"), selection),
    writeFile(join(cwd, "current.py"), "\n" + selection),
    writeFile(
      join(bin, "rg"),
      `#!/bin/sh
for arg do
  case "$arg" in
    --mmap) name=interrupted.py; number=1 ;;
    --no-mmap) name=current.py; number=2 ;;
    --null) list=yes ;;
  esac
done
test -n "$name" || exit 9
if [ "$list" = yes ]; then
  printf './%s\\0' "$name"
else
  printf '{"type":"match","data":{"path":{"text":"%s"},"line_number":%s}}\\n' "$name" "$number"
fi
if [ "$name" = interrupted.py ]; then
  ulimit -c 0
  kill -s BUS "$$"
fi
`,
      { mode: 0o700 },
    ),
  ]);
  const source = new URL(
    "../src/workspace/code-line-search.mjs",
    import.meta.url,
  );
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { createCodeLineSearch } from ${JSON.stringify(source.href)};
       const search = createCodeLineSearch();
       const [cwd, line] = process.argv.slice(1);
       const results = [];
       for (const query of [line.split("\\n")[0], line])
         results.push(await search.search({ cwd, line: query }));
       search.close();
       console.log(JSON.stringify(results));`,
      cwd,
      selection,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: bin + ":" + process.env.PATH },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const expected = { matches: [{ path: join(cwd, "current.py"), line: 2 }] };
  assert.deepEqual(JSON.parse(child.stdout), [expected, expected]);
});
