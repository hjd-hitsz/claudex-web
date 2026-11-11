import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createZstdDecompress } from "node:zlib";

function parse(line) {
  if (!line.includes('"token_count"') && !line.includes('"session_meta"'))
    return null;
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
}

// 分页分支的正文保存在祖先 rollout 中，读取范围由原生 history_base 指定。
// 每次从末尾读取 64 KiB，命中用量即停止，完整拼接记录后才解码 UTF-8。
async function scan(path, endByteOffset) {
  const file = await open(path, "r");
  try {
    let position = (await file.stat()).size;
    if (endByteOffset != null) position = Math.min(position, endByteOffset);
    let remainder = Buffer.alloc(0);
    let base = null;
    function visit(line) {
      const result = extract(parse(line));
      if (result.base) base = result.base;
      return result.tokenUsage ? result : null;
    }
    while (position > 0) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      const data = Buffer.concat([buffer.subarray(0, bytesRead), remainder]);
      let end = data.length;
      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== 10) continue;
        const usage = visit(data.subarray(index + 1, end));
        if (usage) return usage;
        end = index;
      }
      remainder = data.subarray(0, end);
    }
    return visit(remainder) || { base };
  } finally {
    await file.close();
  }
}

function extract(record) {
  const info =
    record?.type === "event_msg" &&
    record.payload?.type === "token_count" &&
    record.payload.info;
  if (!info?.last_token_usage || !info.total_token_usage)
    return {
      base:
        record?.type === "session_meta" ? record.payload?.history_base : null,
    };
  const breakdown = (usage) => ({
    totalTokens: usage.total_tokens,
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  });
  return {
    tokenUsage: {
      total: breakdown(info.total_token_usage),
      last: breakdown(info.last_token_usage),
      modelContextWindow: info.model_context_window,
    },
  };
}

async function scanCompressed(path, endByteOffset) {
  const source = createReadStream(path);
  const stream = source.pipe(createZstdDecompress());
  source.on("error", (error) => stream.destroy(error));
  let remaining = endByteOffset ?? Infinity;
  let remainder = Buffer.alloc(0);
  let result = {};
  function visit(line) {
    const next = extract(parse(line));
    if (next.tokenUsage || next.base) result = next;
  }
  try {
    for await (const chunk of stream) {
      const part = chunk.subarray(0, Math.min(remaining, chunk.length));
      remaining -= part.length;
      const data = Buffer.concat([remainder, part]);
      let start = 0;
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== 10) continue;
        visit(data.subarray(start, index));
        start = index + 1;
      }
      remainder = data.subarray(start);
      if (remaining === 0) break;
    }
    visit(remainder);
    return result;
  } finally {
    source.destroy();
    stream.destroy();
  }
}

async function readRollout(path, endByteOffset) {
  if (path.endsWith(".zst")) return scanCompressed(path, endByteOffset);
  try {
    return await scan(path, endByteOffset);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return scanCompressed(path + ".zst", endByteOffset);
  }
}

export async function readCodexTokenUsage(thread, call) {
  const visited = new Set();
  async function read(thread, endByteOffset) {
    if (!thread?.path || visited.has(thread.id)) return null;
    visited.add(thread.id);
    const result = await readRollout(thread.path, endByteOffset);
    if (result.tokenUsage) return result;
    if (
      !result.base?.thread_id ||
      !Number.isSafeInteger(result.base.end_byte_offset) ||
      result.base.end_byte_offset < 0
    )
      return null;
    const parent = await call("thread/read", {
      threadId: result.base.thread_id,
      includeTurns: false,
    });
    return read(parent.thread, result.base.end_byte_offset);
  }
  return read(thread);
}
