function node() {
  return { kinds: [], children: new Map() };
}

function compact([name, { kinds, children }]) {
  while (!kinds.length && children.size === 1) {
    const [segment, child] = children.entries().next().value;
    name += "/" + segment;
    ({ kinds, children } = child);
  }
  return [name, kinds, ...(children.size ? [[...children].map(compact)] : [])];
}

// Each entry is [path segment, change kinds, optional children]. Join the
// segments with "/" to recover the original path, including empty segments.
export function artifactTree(artifacts) {
  const root = node();
  for (const { path, kind } of artifacts) {
    if (typeof path !== "string") continue;
    let current = root;
    for (const segment of path.split("/")) {
      if (!current.children.has(segment)) current.children.set(segment, node());
      current = current.children.get(segment);
    }
    current.kinds.push(kind ?? null);
  }
  return [...root.children].map(compact);
}
