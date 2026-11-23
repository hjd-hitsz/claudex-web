import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../src/workspace/service.mjs";

test("网页主机服务保存文件、读取目录和执行交互终端命令，文件读取与搜索交原生后端", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-host-"));
  const workspace = createWorkspace({ broadcast() {} });
  t.after(() => workspace.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  assert.equal(workspace.handles("fs/readFile"), false);
  assert.equal(workspace.handles("fuzzyFileSearch"), false);
  await workspace.request("fs/writeFile", {
    path: join(root, "source/example.txt"),
    dataBase64: Buffer.from("已保存的正文").toString("base64"),
  });
  assert.equal(
    await readFile(join(root, "source/example.txt"), "utf8"),
    "已保存的正文",
  );
  const directory = await workspace.request("fs/readDirectory", {
    path: join(root, "source"),
  });
  assert.deepEqual(directory.entries, [
    { fileName: "example.txt", isDirectory: false },
  ]);
  const command = await workspace.request("command/exec", {
    cwd: root,
    command: [process.execPath, "-e", "process.stdout.write('终端输出')"],
  });
  assert.equal(command.exitCode, 0);
  assert.equal(command.stdout, "终端输出");
});

test("三种本机后端均可关联粘贴代码，远端 Codex 保持工作区隔离", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-backend-code-"));
  const workspace = createWorkspace({ broadcast() {} });
  t.after(() => workspace.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sample.js");
  await writeFile(path, "export const example = 42;\n");
  const params = { cwd: root, line: "export const example = 42;" };
  for (const backend of [
    { type: "claude" },
    { type: "opencode" },
    { type: "codex", url: "ws://127.0.0.1:8765" },
  ]) {
    assert.equal(workspace.handles("fuzzyFileSearch", backend, "bridge"), true);
    assert.deepEqual(
      await workspace.request("lan/workspace/codeLine", params, backend),
      {
        matches: [{ path, line: 1 }],
      },
    );
  }
  const remote = { type: "codex", url: "wss://remote.example.test" };
  assert.equal(workspace.handles("fuzzyFileSearch", remote, "backend"), false);
  assert.deepEqual(
    await workspace.request("lan/workspace/codeLine", params, remote),
    { matches: [] },
  );
});
