import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readWorkerLines } from "../src/backends/claude/worker-lines.mjs";

test("Claude IPC 合并拆分的 UTF-8 字节并按顺序交付多条消息", () => {
  const socket = new PassThrough();
  const lines = [];
  readWorkerLines(socket, "超出限制", (line) => lines.push(line));
  const first = Buffer.from('{"text":"中文"}\n');
  socket.write(first.subarray(0, 10));
  assert.deepEqual(lines, []);
  socket.write(Buffer.concat([first.subarray(10), Buffer.from("{}\n{")]));
  assert.deepEqual(lines, ['{"text":"中文"}', "{}"]);
  socket.end("}\n");
  assert.deepEqual(lines, ['{"text":"中文"}', "{}", "{}"]);
});

test("Claude IPC 按 UTF-8 字节限制未完成消息", async () => {
  const socket = new PassThrough();
  const lines = [];
  readWorkerLines(socket, "响应超出限制", (line) => lines.push(line));
  const limit = 128 * 1024 * 1024;
  const text = "中".repeat(Math.floor(limit / 3)) + "ab";
  const failure = once(socket, "error");
  socket.emit("data", text);
  assert.equal(socket.destroyed, false);
  socket.emit("data", "c");
  const [error] = await failure;
  assert.equal(error.message, "响应超出限制");
  assert.deepEqual(lines, []);
});
