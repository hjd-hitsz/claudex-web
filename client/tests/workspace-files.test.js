import test from "node:test";
import assert from "node:assert/strict";
import { readWorkspaceFile } from "../src/infrastructure/workspace-files.js";

test("Antigravity 新建及已有对话通过工作区文件接口读取原始字节", async () => {
  const bytes = new Uint8Array([0xe4, 0xb8, 0xad]);
  for (const threadId of [null, "backend:agy:saved"]) {
    const result = await readWorkspaceFile({
      path: "/folder/测试 #1.md",
      backendId: "agy",
      threadId,
      rpc: () => assert.fail("本机文件由文件接口读取"),
      request: async (url, options) => {
        assert.equal(
          new URLSearchParams(url.split("?")[1]).get("path"),
          "/folder/测试 #1.md",
        );
        assert.deepEqual(options, { credentials: "same-origin" });
        return new Response(bytes);
      },
    });
    assert.deepEqual(result, bytes);
  }
});

test("Codex文件读取保留原生参数，Claude小文件使用原生完整base64读取", async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    return { dataBase64: "5Lit5paH" };
  };
  const request = async (_url, options) => {
    assert.equal(options.method, "HEAD");
    return new Response(null, { headers: { "Content-Length": "6" } });
  };
  assert.equal(
    new TextDecoder().decode(
      await readWorkspaceFile({
        path: "/file",
        backendId: "codex",
        rpc,
        request: () => {
          throw Error("Codex must use native");
        },
      }),
    ),
    "中文",
  );
  assert.deepEqual(calls[0], {
    method: "fs/readFile",
    params: { path: "/file" },
  });
  await readWorkspaceFile({
    path: "/file",
    backendId: "claude",
    cwd: "/project",
    providerId: "provider",
    threadId: "thread",
    rpc,
    request,
  });
  assert.deepEqual(calls[1].params, {
    path: "/file",
    cwd: "/project",
    providerId: "provider",
    threadId: "thread",
  });
});

test("Claude大文件依据实际长度直接使用现有认证HTTP传输", async () => {
  const methods = [];
  const bytes = new Uint8Array([65, 66, 67]);
  const result = await readWorkspaceFile({
    path: "/large.txt",
    backendId: "claude",
    rpc: () => {
      throw Error("native cap");
    },
    request: async (url, options) => {
      assert.equal(url, "/api/files?path=%2Flarge.txt");
      assert.equal(options.credentials, "same-origin");
      methods.push(options.method || "GET");
      return options.method === "HEAD"
        ? new Response(null, { headers: { "Content-Length": "10000001" } })
        : new Response(bytes);
    },
  });
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.deepEqual(result, bytes);
});
