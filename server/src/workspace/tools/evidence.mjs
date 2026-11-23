import { z } from "zod";
import { filePath, mergeRanges } from "./ranges.mjs";

export const findInput = z.strictObject({
  url: z
    .url()
    .refine((url) => /^https?:\/\//i.test(url), "Use an HTTP or HTTPS URL"),
  terms: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  startLine: z.int().min(1).optional(),
  contextLines: z.int().min(0).max(8).optional(),
});

export const grepInput = z.strictObject({
  pattern: z.string().min(1).max(2048),
  path: filePath.optional(),
  include: z.string().min(1).max(2048).optional(),
  literal: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  mode: z.enum(["files", "count", "content"]).optional(),
  limit: z.int().min(1).max(500).optional(),
});

export function pageEvidence(
  page,
  { url, terms, startLine = 1, contextLines = 2 },
) {
  const lines = page.split(/\r?\n/);
  const needles = terms.map((term) => term.toLowerCase());
  const matches = [];
  for (let i = startLine - 1; i < lines.length && matches.length < 13; i += 1) {
    const line = lines[i].toLowerCase();
    if (needles.some((term) => line.includes(term))) matches.push(i);
  }
  if (!matches.length) return;
  const next = matches[12];
  const ranges = mergeRanges(
    matches.slice(0, 12).map((line) => ({
      start: Math.max(0, line - contextLines),
      end: Math.min(lines.length - 1, line + contextLines),
    })),
  );
  const result = [url];
  let remaining = 12_000;
  for (const { start, end } of ranges) {
    if (remaining <= 0) {
      result.push(`[Continue from line ${start + 1}.]`);
      break;
    }
    const excerpt = lines
      .slice(start, end + 1)
      .map((line) =>
        line.length <= 1200 ? line : excerptAroundTerm(line, needles),
      )
      .join("\n");
    const block = `Lines ${start + 1}-${end + 1}\n${excerpt}`;
    if (block.length > remaining) {
      result.push(
        block.slice(0, remaining),
        `[Result shortened. Continue from line ${start + 1} with less context.]`,
      );
      break;
    }
    result.push(block);
    remaining -= block.length;
  }
  if (next !== undefined)
    result.push(`[More matches. Continue from line ${next + 1}.]`);
  return result.join("\n\n");
}

function excerptAroundTerm(line, needles) {
  const lower = line.toLowerCase();
  const match = needles
    .map((term) => lower.indexOf(term))
    .find((index) => index >= 0);
  const start = Math.max(0, (match ?? 0) - 180);
  const excerpt = line.slice(start, start + 1200);
  return `${start ? "…" : ""}${excerpt}${start + excerpt.length < line.length ? "…" : ""}`;
}

export function searchSummary(result, mode) {
  const matches = result.output;
  if (!matches.length) return "No matches.";
  const groups = Map.groupBy(matches, ({ entry }) => entry.path);
  const note = result.metadata?.truncated
    ? "\n[Result limited. Narrow the search for complete counts.]"
    : "";
  return (
    [...groups]
      .map(([path, items]) => {
        if (mode === "files") return path;
        if (mode === "count") return `${path}: ${items.length}`;
        return `${path}\n${items.map(({ line, text }) => `${line}: ${text}`).join("\n")}`;
      })
      .join("\n") + note
  );
}
