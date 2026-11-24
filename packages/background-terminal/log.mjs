// @ts-check
import { open } from "node:fs/promises";

/** @param {string} path @param {number | null | undefined} offset */
export async function readTaskLog(path, offset, limit = 32768) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const start = Math.min(offset ?? Math.max(0, size - limit), size);
    const bytes = Buffer.alloc(Math.min(limit + 4, size - start));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    let end = Math.min(limit, bytesRead);
    let begin = 0;
    // 每一页从完整 UTF-8 字符边界开始。
    if (end < bytesRead) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    if (start > 0)
      while (begin < end && (bytes[begin] & 0xc0) === 0x80) begin++;
    return {
      output: bytes.subarray(begin, end).toString("utf8"),
      offset: start + begin,
      nextOffset: start + end,
      bytes: size,
    };
  } finally {
    await file.close();
  }
}
