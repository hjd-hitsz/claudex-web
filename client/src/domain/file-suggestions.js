function normalize(value) {
  return value.normalize("NFKC").replaceAll("\\", "/");
}

function nameRelevance(name, query, directory) {
  const text = name.toLowerCase();
  const extension = text.lastIndexOf(".");
  const stem = !directory && extension > 0 ? text.slice(0, extension) : text;
  if (text === query) return [9, 0, 0];
  if (stem === query) return [8, 0, 0];
  if (stem.replace(/[^\p{L}\p{N}]+/gu, "") === query) return [7, 0, 0];
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
  return null;
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

// Promote direct matches before trimming the menu. Native fuzzy hits keep their order.
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
      const directory = file.directory === true;
      const visible =
        explicitHidden || !parts.some((part) => part.startsWith("."));
      const nameRank = nameRelevance(normalize(file.name), term, directory);
      const pathRank = usesPath
        ? pathRelevance(
            anchored ? full.split("/").filter(Boolean) : parts,
            queryParts,
            anchored,
            nameRank,
          )
        : null;
      const rank = usesPath
        ? pathRank && [1, ...pathRank, Number(directory), -parts.length]
        : nameRank && [
            1,
            Number(directory),
            Number(visible),
            ...nameRank,
            -parts.length,
          ];
      return { file, rank: rank || [0], index };
    })
    .sort((a, b) => compare(a.rank, b.rank) || a.index - b.index)
    .map(({ file }) => file);
}
