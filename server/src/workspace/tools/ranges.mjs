import { relative, resolve } from "node:path";
import { z } from "zod";

export const readDescription =
  "Read one or more files or directories. Batch related paths in one call. Omit start and end to read from the beginning with the native page size. Adjacent and overlapping line ranges are combined. Supports absolute paths, relative paths, skill resources, images, and PDFs.";

export const filePath = z.string().min(1);
export const readInput = z.strictObject({
  files: z
    .array(
      z.strictObject({
        path: filePath,
        start: z.int().min(1).optional(),
        end: z.int().min(1).optional(),
      }),
    )
    .min(1),
});

export function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export async function readRanges(cwd, value, read, signal) {
  const { files } = readInput.parse(value);
  const grouped = new Map();
  for (const { path, start = 1, end = Infinity } of files) {
    if (end < start)
      throw new Error(`Invalid line range: ${path}:${start}-${end}`);
    const key =
      path.startsWith("skill://") || path === "~" || path.startsWith("~/")
        ? path
        : relative(cwd, resolve(cwd, path)) || ".";
    if (!grouped.has(key)) grouped.set(key, { path, ranges: [] });
    grouped.get(key).ranges.push({ start, end });
  }
  const rows = [];
  for (const { path, ranges } of grouped.values()) {
    for (const range of mergeRanges(ranges)) {
      signal?.throwIfAborted();
      try {
        rows.push(await read({ path, ...range }));
      } catch (error) {
        signal?.throwIfAborted();
        rows.push({ error, text: `${path}: ${error.message}` });
      }
    }
  }
  if (rows.every((row) => row.error)) throw rows[0].error;
  return rows;
}

export function formatReadRange(path, start, lines, note) {
  const label = lines.length
    ? `${path}:${start}-${start + lines.length - 1}`
    : `${path}:${start}`;
  return [label, ...lines, ...(note ? [`[${note}]`] : [])].join("\n");
}
