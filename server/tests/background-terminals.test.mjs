import test from "node:test";
import assert from "node:assert/strict";
import {
  backgroundParams,
  backgroundTerminals,
} from "../src/backends/codex/background-terminals.mjs";

test("Codex 在启用时对新建、恢复和分支注册 MCP，保留所有既有配置", () => {
  const params = { config: { "mcp_servers.other": { enabled: true } } };
  const url = "ws://localhost:1234";
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    assert.equal(backgroundParams(method, params, null, url), params);
    const merged = backgroundParams(method, params, "/tmp/test", url);
    assert.equal(
      merged.config["mcp_servers.other"],
      params.config["mcp_servers.other"],
    );
    assert.equal(
      merged.config["mcp_servers.claudex_background"].env
        .CLAUDEX_BACKGROUND_UPSTREAM,
      url + "/",
    );
  }
  assert.equal(
    backgroundParams("turn/start", params, "/tmp/test", url),
    params,
  );
});

test("后台终端先读完原生分页，再按游标读取本会话仍在运行的扩展任务", async () => {
  const jobs = ["c", "b", "a"].map((id) => ({
    id,
    status: "running",
    command: "test",
    cwd: "/project",
  }));
  const native = (method, p) => ({
    data: [{ processId: p.cursor ? "n2" : "n1" }],
    nextCursor: p.cursor ? null : "native-2",
  });
  const request = async (dir, method, p) => {
    assert.equal(p.threadId, "mine");
    return { jobs };
  };
  const call = backgroundTerminals(
    "/tmp/test",
    "ws://localhost:1",
    native,
    request,
  );
  const page = (cursor) =>
    call("thread/backgroundTerminals/list", {
      threadId: "mine",
      limit: 1,
      cursor,
    });
  let result = await page();
  assert.equal(result.data[0].processId, "n1");
  result = await page(result.nextCursor);
  assert.equal(result.data[0].processId, "n2");
  result = await page(result.nextCursor);
  assert.equal(result.data[0].processId, "a");
  jobs.pop();
  result = await page(result.nextCursor);
  assert.equal(result.data[0].processId, "b");
  result = await page(result.nextCursor);
  assert.deepEqual([result.data[0].processId, result.nextCursor], ["c", null]);
});
