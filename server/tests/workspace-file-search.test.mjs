import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFileSearch } from "../src/workspace/file-search.mjs";
import { createBackendManager } from "../src/backends/manager.mjs";
import { resourceId } from "../../shared/backend-identity.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "claudex-file-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, path, text = "") {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
}

test("在结果截断前同时搜索目录和文件，并按名称、层级和模糊相关性排序", async (t) => {
  const root = await workspace(t);
  const search = createFileSearch();
  t.after(() => search.close());
  await Promise.all([
    ...Array.from({ length: 75 }, (_, index) =>
      write(root, `archive/nros${index}.py`),
    ),
    write(root, "nros_marsupial/params.py"),
    write(root, "nros_marsupial/src/nros_marsupial/planner/params.py"),
    write(root, "src/backends/claude/token-usage.mjs"),
    write(root, "src/backends/codex/token-usage.mjs"),
    write(root, "资料/分析笔记.md"),
    write(root, ".gitignore", "generated/\n"),
    write(root, "generated/target.js"),
    write(root, "src/.gitignore", "*.log\n!keep.log\n"),
    write(root, "src/keep.log"),
    write(root, "src/discard.log"),
  ]);
  await symlink(root, join(root, "loop"));
  const suggest = (query) => search.search({ roots: [root], query });
  const { files } = await suggest("nros");
  assert.equal(files.length, 60);
  assert.equal(files[0].path, "nros_marsupial");
  assert.equal(files[0].match_type, "directory");
  for (const [query, expected] of [
    ["nrosmas", "nros_marsupial"],
    ["nrosmasp", "nros_marsupial"],
    ["nms/params", "nros_marsupial/params.py"],
    ["cld/tknusg", "src/backends/claude/token-usage.mjs"],
    ["./src/backends/codex/token", "src/backends/codex/token-usage.mjs"],
    ["资料/分析", "资料/分析笔记.md"],
    ["keep.log", "src/keep.log"],
  ]) {
    assert.equal((await suggest(query)).files[0]?.path, expected, query);
  }
  assert.deepEqual((await suggest("target.js")).files, []);
  assert.deepEqual((await suggest("discard.log")).files, []);
  assert.equal((await suggest("loop")).files[0].match_type, "directory");
});

test("搜索失败后可重新读取工作区，并按根目录隔离并发索引", async (t) => {
  const root = await workspace(t);
  const search = createFileSearch();
  t.after(() => search.close());
  const first = join(root, "first");
  const second = join(root, "second");
  const suggest = (folder) =>
    search.search({ roots: [folder], query: "report" });
  await assert.rejects(suggest(first), { code: "ENOENT" });
  await write(first, "report.md");
  await write(second, "report.txt");
  const results = await Promise.all([
    suggest(first),
    suggest(second),
    suggest(first),
  ]);
  assert.deepEqual(
    results.map(({ files }) => [files[0].root, files[0].path]),
    [
      [first, "report.md"],
      [second, "report.txt"],
      [first, "report.md"],
    ],
  );
});

test("网页搜索按所属工作区路由，本机两端共用搜索，Codex 可独立使用", async (t) => {
  const root = await workspace(t);
  const project = join(root, "project");
  await write(project, "target-directory/readme.md");
  const nativeCalls = [];
  const factory = ({ backend, send }) => ({
    ready: false,
    workspaceOwner: backend.id === "codex" ? "backend" : "bridge",
    state: () => ({ params: {} }),
    connect() {},
    close() {},
    receive(client, message) {
      nativeCalls.push(message.method);
      send(client, { id: message.id, result: {} });
    },
  });
  for (const enableClaude of [false, true]) {
    const backendsFile = join(root, "backends.json");
    await writeFile(
      backendsFile,
      JSON.stringify({
        backends: [
          { id: "codex", type: "codex", enabled: true },
          { id: "claude", type: "claude", enabled: enableClaude },
        ],
        providers: [],
      }),
    );
    const manager = createBackendManager({
      config: {
        configDir: root,
        claudeHome: root,
        codexHome: root,
        backendsFile,
        upstreamUrl: "ws://127.0.0.1:1",
      },
      version: {},
      send: (client, message) => client.deliver(message),
      broadcast() {},
      factories: {
        codex: factory,
        claude: factory,
        installation: { state: () => ({}) },
      },
    });
    try {
      await manager.connect();
      const suggest = (backendId, threadId) =>
        new Promise((resolve, reject) => {
          manager
            .receive(
              { readyState: 1, deliver: ({ result }) => resolve(result) },
              {
                id: 1,
                method: "fuzzyFileSearch",
                params: {
                  backendId,
                  threadId,
                  roots: [project],
                  query: "tgtdir",
                },
              },
            )
            .catch(reject);
        });
      const codex = await suggest("codex");
      assert.equal(codex.ranked, true);
      assert.equal(codex.files[0]?.path, "target-directory");
      if (enableClaude)
        assert.deepEqual(
          await suggest("claude", resourceId("claude", "session")),
          codex,
        );
    } finally {
      await manager.close();
    }
  }
  assert.deepEqual(nativeCalls, []);
});
