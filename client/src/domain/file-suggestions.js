function normalize(value) {
  return value.normalize("NFKC").replaceAll("\\", "/");
}

function fuzzyRelevance(text, query) {
  let best = null;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== query[0]) continue;
    let matched = 1;
    let end = start;
    while (++end < text.length && matched < query.length)
      if (text[end] === query[matched]) matched++;
    if (matched === query.length) {
      const rank = [1, -(end - start - query.length), -start];
      if (!best || compare(rank, best) < 0) best = rank;
    }
  }
  return best;
}

function nameRelevance(name, query, directory) {
  const text = name.toLowerCase();
  const extension = text.lastIndexOf(".");
  const stem = !directory && extension > 0 ? text.slice(0, extension) : text;
  if (text === query) return [8, 0, 0];
  if (stem === query) return [7, 0, 0];
  if (text.startsWith(query)) return [6, -stem.length, 0];

  const words = name
    .replace(/([\p{Ll}\p{N}])(?=\p{Lu})/gu, "$1 ")
    .replace(/(\p{Lu})(?=\p{Lu}\p{Ll})/gu, "$1 ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const exactWord = words.indexOf(query);
  if (exactWord >= 0) return [5, -exactWord, -stem.length];
  const wordPrefix = words.findIndex((part) => part.startsWith(query));
  if (wordPrefix >= 0) return [4, -wordPrefix, -stem.length];
  const initials = words.map((part) => part[0]).join("");
  if (initials.startsWith(query)) return [3, -initials.length, -stem.length];
  const offset = text.indexOf(query);
  if (offset >= 0) return [2, -offset, -stem.length];
  const fuzzy = fuzzyRelevance(text, query);
  if (directory && query.length === 2 && fuzzy && fuzzy[1] < -query.length)
    return null;
  return fuzzy;
}

function pathRelevance(parts, query, anchored, nameRank) {
  const offset = parts.length - query.length;
  if (offset < 0 || (anchored && offset !== 0) || !nameRank) return null;
  let exactParents = 0;
  for (let i = 0; i < query.length - 1; i++) {
    const parent = parts[offset + i];
    if (parent === query[i]) exactParents++;
    else if (anchored || !parent.startsWith(query[i])) return null;
  }
  return [exactParents, ...nameRank];
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

// Rank the complete native result set before the menu applies its display limit.
export function rankFileSuggestions(files, query, cwd) {
  const q = normalize(query).toLowerCase();
  if (!q || q.endsWith("/")) return files;
  const root = normalize(cwd).toLowerCase().replace(/\/$/, "");
  const usesPath = q.includes("/");
  const anchored = /^(?:\/|\.\.?\/)/.test(q);
  const queryParts =
    anchored && !q.startsWith("/") ? root.split("/").filter(Boolean) : [];
  const segments = q.split("/").filter(Boolean);
  const term = segments.pop();
  for (const part of segments) {
    if (part === "..") queryParts.pop();
    else if (part !== ".") queryParts.push(part);
  }
  queryParts.push(term);
  const explicitHidden =
    term.startsWith(".") ||
    segments.some(
      (part) => part.startsWith(".") && part !== "." && part !== "..",
    );
  return files
    .map((file, index) => {
      const full = normalize(file.path).toLowerCase();
      const path = full.startsWith(root + "/")
        ? full.slice(root.length + 1)
        : full;
      const parts = path.split("/").filter(Boolean);
      const parents = parts.slice(0, -1);
      const directory = file.directory === true;
      const visible =
        explicitHidden || !parts.some((part) => part.startsWith("."));
      const nameRank = nameRelevance(normalize(file.name), term, directory);
      let rank = nameRank;
      if (usesPath) {
        rank = pathRelevance(
          anchored ? full.split("/").filter(Boolean) : parts,
          queryParts,
          anchored,
          nameRank,
        );
      } else if (
        !rank &&
        !directory &&
        parents.some((parent) => parent.startsWith(q))
      ) {
        rank = [0, 0, 0];
      }
      if (!rank) return null;
      return {
        file,
        rank: [
          Number(directory),
          Number(nameRank !== null),
          Number(visible),
          ...rank,
          -parts.length,
        ],
        index,
      };
    })
    .filter(Boolean)
    .sort((a, b) => compare(a.rank, b.rank) || a.index - b.index)
    .map(({ file }) => file);
}
