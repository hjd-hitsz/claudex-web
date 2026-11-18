import test from "node:test";
import assert from "node:assert/strict";
import { rankFileSuggestions } from "../src/domain/file-suggestions.js";
const file = (path) => ({
  path: "/work/" + path,
  name: path.split("/").at(-1),
});
const rank = (paths, query) =>
  rankFileSuggestions(paths.map(file), query, "/work").map((f) =>
    f.path.slice(6),
  );

test("跨目录按名称相关性排序，父目录匹配的子文件后置", () => {
  assert.deepEqual(
    rank(
      ["target/a.js", "target/b.js", "z/target.js", "target-extra", "target"],
      "target",
    ),
    ["target", "z/target.js", "target-extra", "target/a.js", "target/b.js"],
  );
});
test("相关性先于数量限制，遍历后部的精确结果进入首屏", () => {
  const files = [
    ...Array.from({ length: 80 }, (_, i) => file(`target/${i}.js`)),
    file("z/target"),
  ];
  assert.equal(
    rankFileSuggestions(files, "target", "/work").slice(0, 60)[0].path,
    "/work/z/target",
  );
});
test("文件夹优先于精确匹配的文件，并在限制展示数量前排序", () => {
  const files = [
    ...Array.from({ length: 60 }, (_, i) => file(`src/${i}/target`)),
    { ...file("src/target-assets"), directory: true },
    { ...file("src/target-extra-long"), directory: true },
    { ...file("src/target-extra"), directory: true },
  ];
  const ranked = rankFileSuggestions(files, "target", "/work").slice(0, 60);
  assert.deepEqual(
    ranked.slice(0, 4).map(({ path }) => path),
    [
      "/work/src/target-extra",
      "/work/src/target-assets",
      "/work/src/target-extra-long",
      "/work/src/0/target",
    ],
  );
});
test("路径输入按完整路径匹配，支持大小写、中文和跳字", () => {
  assert.deepEqual(rank(["src/target-old", "src/target"], "src/target"), [
    "src/target",
    "src/target-old",
  ]);
  assert.deepEqual(rank(["a/分析目录/x", "b/分析.md"], "分析"), [
    "b/分析.md",
    "a/分析目录/x",
  ]);
  assert.deepEqual(rank(["a/T---a---r---g---e---t", "b/Target"], "tgt"), [
    "b/Target",
    "a/T---a---r---g---e---t",
  ]);
});
test("同分保持原生顺序，目录浏览保持原有顺序且不修改输入", () => {
  const files = [file("b/target"), file("a/target")];
  const snapshot = structuredClone(files);
  assert.deepEqual(rankFileSuggestions(files, "target", "/work"), files);
  assert.equal(rankFileSuggestions(files, "", "/work"), files);
  assert.equal(rankFileSuggestions(files, "src/", "/work"), files);
  assert.deepEqual(files, snapshot);
});

test("精确、短前缀、长前缀、连续与跳字匹配依次排序", () => {
  assert.deepEqual(
    rank(["t-a-r", "x-target", "target-long", "target", "tar"], "tar"),
    ["tar", "target", "target-long", "x-target", "t-a-r"],
  );
});

test("文件主名与名称分词优先，同分时优先较浅的路径", () => {
  assert.deepEqual(
    rank(
      [
        "deep/dir/target.js",
        "retarget.js",
        "target-old.js",
        "parseTarget.js",
        "pre-targeting.js",
        "target.md",
        "target",
      ],
      "target",
    ),
    [
      "target",
      "target.md",
      "deep/dir/target.js",
      "target-old.js",
      "parseTarget.js",
      "pre-targeting.js",
      "retarget.js",
    ],
  );
});

test("名称缩写优先于零散跳字，普通查询将隐藏路径后置", () => {
  const paths = [
    ".git/hooks/fsmonitor.sample",
    "files.js",
    "diffs.css",
    "file-suggestions.js",
    "random.js",
  ];
  assert.deepEqual(rank(paths, "fs"), [
    "file-suggestions.js",
    "diffs.css",
    "files.js",
    ".git/hooks/fsmonitor.sample",
  ]);
  assert.deepEqual(rank(paths, ".git/hooks/fs"), [
    ".git/hooks/fsmonitor.sample",
  ]);
});

test("双字符关键词保留紧凑的文件夹匹配，过滤间隔过大的跳字", () => {
  const files = [
    { ...file("tests/fixtures"), directory: true },
    { ...file("client/src/features"), directory: true },
    { ...file("file-suggestions"), directory: true },
    { ...file("f-s"), directory: true },
    { ...file("fts"), directory: true },
    file("file-suggestions.js"),
  ];
  assert.deepEqual(rankFileSuggestions(files, "fs", "/work"), [
    files[3],
    files[2],
    files[4],
    files[5],
  ]);
});

test("路径查询逐级匹配，根目录前缀限定匹配范围", () => {
  const paths = [
    "client/src/assets/providers",
    "server/src/server.mjs",
    "src/server.js",
    "server/src-old/server",
    "src/test/server.js",
    "othersrc/server.js",
  ];
  assert.deepEqual(rank(paths, "src/server"), [
    "src/server.js",
    "server/src/server.mjs",
    "server/src-old/server",
  ]);
  assert.deepEqual(rank(paths, "./src/server"), ["src/server.js"]);
  assert.deepEqual(rank(paths, "/work/src/server"), ["src/server.js"]);
  assert.deepEqual(rank(paths, "SRC\\SERVER"), rank(paths, "src/server"));
});

test("只命中父级的文件后置，文件夹须匹配自身名称", () => {
  const files = [
    { ...file("target/fixtures"), directory: true },
    file("target/config.json"),
    file("elsewhere/retarget.js"),
    { ...file("target-tools"), directory: true },
  ];
  assert.deepEqual(rankFileSuggestions(files, "target", "/work"), [
    files[3],
    files[2],
    files[1],
  ]);
});
