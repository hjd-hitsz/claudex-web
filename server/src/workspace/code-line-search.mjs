import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  CODE_LINE_FILE_LIMIT,
  isCodeLineSnippet,
} from "../../../shared/code-line-reference.mjs";

function startSearch(cwd, signal, mode, flags, anchor) {
  const child = spawn(
    "rg",
    [
      "--no-config",
      "--no-require-git",
      "--fixed-strings",
      mode,
      ...flags,
      "--",
      anchor,
      ".",
    ],
    { cwd, signal, stdio: ["ignore", "pipe", "ignore"] },
  );
  const exit = new Promise((done) => {
    child.once("error", () => done({ code: null }));
    child.once("close", (code, signal) => done({ code, signal }));
  });
  return { child, exit };
}

async function searchResult(exit, matches) {
  const { code, signal } = await exit;
  if (signal === "SIGBUS") return null;
  return {
    matches:
      code === 0 && matches.length <= CODE_LINE_FILE_LIMIT
        ? matches.sort((a, b) => a.path.localeCompare(b.path))
        : [],
  };
}

async function searchLine(cwd, signal, mode, line) {
  const { child, exit } = startSearch(
    cwd,
    signal,
    mode,
    ["--json", "--line-regexp", "--crlf", "--max-count=1"],
    line,
  );
  const matches = [];
  try {
    const output = createInterface({ input: child.stdout });
    for await (const value of output) {
      const { type, data } = JSON.parse(value);
      if (type !== "match") continue;
      if (!data.path.text) return { matches: [] };
      matches.push({
        path: resolve(cwd, data.path.text),
        line: data.line_number,
      });
      if (matches.length > CODE_LINE_FILE_LIMIT) return { matches: [] };
    }
    return await searchResult(exit, matches);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function* matchingPaths(output) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of output) {
    pending += decoder.decode(chunk, { stream: true });
    const paths = pending.split("\0");
    pending = paths.pop();
    yield* paths;
  }
  if (pending || decoder.decode()) throw new Error("无效的工作区文件名。");
}

async function* sourceLineBatches(path, signal) {
  const input = createReadStream(path, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    signal,
  });
  let decoder;
  let pending = "";
  for await (const chunk of input) {
    decoder ??= new TextDecoder(
      chunk[0] === 0xff && chunk[1] === 0xfe
        ? "utf-16le"
        : chunk[0] === 0xfe && chunk[1] === 0xff
          ? "utf-16be"
          : "utf-8",
    );
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    yield lines;
  }
  pending += decoder?.decode() ?? "";
  if (pending) yield [pending];
}

async function matchSnippet(path, signal, lines) {
  const window = new Array(lines.length);
  const head = lines[0];
  const tail = lines.at(-1);
  const interior = lines.slice(1, -1);
  let number = 0;
  let clipped;
  for await (const batch of sourceLineBatches(path, signal)) {
    for (const raw of batch) {
      const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      window[number++ % lines.length] = text;
      if (number < lines.length || !text.startsWith(tail)) continue;
      const first = window[number % lines.length];
      if (!first.endsWith(head)) continue;
      if (
        !interior.every(
          (value, index) =>
            value === window[(number + index + 1) % lines.length],
        )
      )
        continue;
      const line = number - lines.length + 1;
      if (first === head && text === tail) return { line, exact: true };
      clipped ??= { line, exact: false };
    }
  }
  return clipped;
}

async function searchSnippet(cwd, signal, mode, lines) {
  const interior = lines.slice(1, -1).filter((line) => line.trim());
  const anchors = interior.length ? interior : [lines[0], lines.at(-1)];
  const anchor = anchors.reduce((best, line) =>
    line.length > best.length ? line : best,
  );
  // 定位行负责筛选文件，完整片段校验只读取这些候选文件。
  const { child, exit } = startSearch(
    cwd,
    signal,
    mode,
    [
      "--files-with-matches",
      "--null",
      ...(interior.length ? ["--line-regexp", "--crlf"] : []),
    ],
    anchor,
  );
  const exact = [];
  const clipped = [];
  try {
    for await (const relative of matchingPaths(child.stdout)) {
      const path = resolve(cwd, relative);
      const match = await matchSnippet(path, signal, lines);
      if (!match) continue;
      const group = match.exact ? exact : clipped;
      if (group.length <= CODE_LINE_FILE_LIMIT)
        group.push({ path, line: match.line });
      if (exact.length > CODE_LINE_FILE_LIMIT) return { matches: [] };
    }
    return await searchResult(exit, exact.length ? exact : clipped);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function searchWorkspace(cwd, signal, line) {
  const lines = line.split("\n");
  const scan = (mode) =>
    lines.length === 1
      ? searchLine(cwd, signal, mode, line)
      : searchSnippet(cwd, signal, mode, lines);
  const result = await scan("--mmap");
  if (result || signal.aborted) return result ?? { matches: [] };
  // 文件在映射读取期间被截断时，重新用缓冲读取完成同一次查询。
  return (await scan("--no-mmap")) ?? { matches: [] };
}

export function createCodeLineSearch() {
  const lifetime = new AbortController();
  return {
    search({ cwd, line }) {
      if (
        typeof cwd !== "string" ||
        !isAbsolute(cwd) ||
        !isCodeLineSnippet(line)
      )
        throw new Error("代码定位需要绝对工作目录和有效代码片段。");
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(1800),
      ]);
      return searchWorkspace(cwd, signal, line).catch(() => ({ matches: [] }));
    },
    close: () => lifetime.abort(),
  };
}
