import { readFile, readdir, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setImmediate } from "node:timers/promises";
import fuzzysort from "fuzzysort";
import ignore from "ignore";

const RESULT_LIMIT = 60;
const SCAN_BATCH_SIZE = 32;
const SEARCH_BATCH_SIZE = 8192;
const PREPARED_BATCH_LIMIT = 4;
const INDEX_LIFETIME_MS = 5000;
const MAX_CACHED_ROOTS = 3;
const normalize = (text) => text.normalize("NFKC").toLowerCase();

async function readDirectory(root, path) {
  try {
    return await readdir(join(root, path), { withFileTypes: true });
  } catch (error) {
    // A descendant can disappear while the workspace is being indexed.
    if (!path || !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code))
      throw error;
    return [];
  }
}

function ignored(path, layers) {
  let excluded = false;
  for (const { base, rules } of layers) {
    const result = rules.test(path.slice(base.length));
    if (result.ignored || result.unignored) excluded = result.ignored;
  }
  return excluded;
}

async function directoryEntries(root, entry) {
  const children = await readDirectory(root, entry.path);
  const names = new Set(children.map(({ name }) => name));
  const files = [".gitignore", ".ignore"].filter((name) => names.has(name));
  const patterns = await Promise.all(
    files.map((name) =>
      readFile(join(root, entry.path, name), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      }),
    ),
  );
  const layers = files.length
    ? [
        ...entry.layers,
        {
          base: entry.path ? entry.path + "/" : "",
          rules: ignore().add(patterns.join("\n")),
        },
      ]
    : entry.layers;
  return { path: entry.path, children, layers };
}

async function buildIndex(root, signal) {
  const pending = [{ path: "", layers: [] }];
  const batches = [];
  const append = (entries) =>
    batches.push(
      batches.length < PREPARED_BATCH_LIMIT
        ? fuzzysort.snapshot(entries, { key: "target" })
        : entries,
    );
  let entries = [];
  while (pending.length) {
    signal.throwIfAborted();
    const directories = pending.splice(-SCAN_BATCH_SIZE);
    const contents = await Promise.all(
      directories.map((entry) => directoryEntries(root, entry)),
    );
    for (const { path: parent, children, layers } of contents) {
      for (const child of children) {
        const path = parent ? parent + "/" + child.name : child.name;
        const directory =
          child.isDirectory() ||
          (child.isSymbolicLink() &&
            (await stat(join(root, path)).then(
              (target) => target.isDirectory(),
              () => false,
            )));
        if (ignored(directory ? path + "/" : path, layers)) continue;
        if (child.isDirectory() && child.name !== ".git")
          pending.push({ path, layers });
        const name = normalize(child.name);
        entries.push({
          path,
          file_name: child.name,
          match_type: directory ? "directory" : "file",
          name,
          target: normalize(path),
          depth: path.split("/").length,
          hidden: path.startsWith(".") || path.includes("/."),
        });
        if (entries.length === SEARCH_BATCH_SIZE) {
          append(entries);
          entries = [];
        }
      }
    }
  }
  if (entries.length) append(entries);
  return batches;
}

function searchQuery(root, input) {
  const text = input.replaceAll("\\", "/").trim();
  const query = normalize(text);
  if (!query) return null;
  const anchored = /^(?:\/|\.\.?\/)/.test(query);
  const pathQuery = query.includes("/");
  const term = query.slice(query.lastIndexOf("/") + 1);
  if (!term) return null;
  const rooted = anchored ? relative(root, resolve(root, text)) : "";
  if (anchored && (rooted === ".." || rooted.startsWith("../"))) return null;
  return {
    query: anchored ? normalize(rooted) : query,
    term,
    pathQuery,
    parent: anchored ? dirname(normalize(rooted)) : null,
    parentTerm: pathQuery ? basename(dirname(query)) : "",
    explicitHidden: query.split("/").some((part) => /^\.[^.]/.test(part)),
  };
}

function relevance(
  match,
  { query, term, pathQuery, parent, parentTerm, explicitHidden },
) {
  const { name, target, match_type, hidden, depth } = match.obj;
  const directoryPath = pathQuery ? dirname(target) : "";
  if (parent !== null && directoryPath !== parent) return 0;
  const directory = match_type === "directory";
  const nameMatch = fuzzysort.single(term, name);
  if (!nameMatch && (pathQuery || directory)) return 0;
  const stem = directory ? name : name.replace(/(?<=.)\.[^.]+$/, "");
  const exactPath = target === query || target.endsWith("/" + query);
  const prefixPath = ("/" + target).includes("/" + query);
  const grade =
    pathQuery && exactPath
      ? 6
      : pathQuery && prefixPath
        ? 5
        : name === term || stem === term
          ? 4
          : name.startsWith(term)
            ? 3
            : nameMatch
              ? 2
              : 1;
  const parentMatch =
    parentTerm && fuzzysort.single(parentTerm, basename(directoryPath));
  const quality = pathQuery
    ? 0.45 * (parentMatch?.score || 0) +
      0.35 * nameMatch.score +
      0.2 * match.score
    : (nameMatch?.score ?? match.score);
  return (
    ((directory ? 16 : 0) +
      (explicitHidden || !hidden ? 8 : 0) +
      grade +
      quality * 0.8 +
      0.15 / depth) /
    32
  );
}

export function createFileSearch() {
  const controller = new AbortController();
  const indexes = new Map();

  function index(root) {
    const now = Date.now();
    let entry = indexes.get(root);
    if (!entry || entry.expires <= now) {
      entry = { expires: Infinity };
      const current = entry;
      entry.batches = buildIndex(root, controller.signal).then(
        (batches) => {
          current.expires = Date.now() + INDEX_LIFETIME_MS;
          return batches;
        },
        (error) => {
          if (indexes.get(root) === current) indexes.delete(root);
          throw error;
        },
      );
    }
    indexes.delete(root);
    indexes.set(root, entry);
    if (indexes.size > MAX_CACHED_ROOTS)
      indexes.delete(indexes.keys().next().value);
    return entry.batches;
  }

  return {
    async search({ roots, query }) {
      if (
        typeof query !== "string" ||
        !Array.isArray(roots) ||
        !roots.every((root) => typeof root === "string" && isAbsolute(root))
      )
        throw new Error("文件搜索需要关键词和绝对工作目录");
      const matches = [];
      for (const root of new Set(roots.map((path) => resolve(path)))) {
        const request = searchQuery(root, query);
        if (!request) continue;
        for (const batch of await index(root)) {
          await setImmediate(undefined, { signal: controller.signal });
          const results = fuzzysort.go(request.query, batch, {
            ...(Array.isArray(batch) && { key: "target" }),
            threshold: 0,
            limit: RESULT_LIMIT,
            scoreFn: (match) => relevance(match, request),
          });
          for (const {
            obj: { path, file_name, match_type },
            score,
          } of results)
            matches.push({ root, path, file_name, match_type, score });
          if (Array.isArray(batch)) fuzzysort.cleanup();
        }
      }
      fuzzysort.cleanup();
      matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return { files: matches.slice(0, RESULT_LIMIT), ranked: true };
    },
    close() {
      controller.abort();
      indexes.clear();
      fuzzysort.cleanup();
    },
  };
}
