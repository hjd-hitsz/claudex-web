export function traceItems(turn, trace) {
  const items = new Map(
    (turn.items ?? []).map((item) => [item.id ?? Symbol(), item]),
  );
  for (const [id, item] of trace?.items ?? []) {
    const native = items.get(id);
    items.set(
      id,
      native
        ? {
            ...item,
            ...native,
            ...(item.text && { text: item.text }),
            ...(item.phase && { phase: item.phase }),
          }
        : item,
    );
  }
  return items;
}

export function traceOrder(entries, trace) {
  if (!trace?.positions?.size) return [...entries.values()];
  const ordered = [...trace.positions]
    .filter(([id]) => entries.has(id))
    .sort(([, a], [, b]) => a.time - b.time || a.sequence - b.sequence);
  // Native history can contain items absent from older rollouts. Preserve
  // their native sequence relative to the next item with a recorded time.
  const before = new Map();
  let unrecorded = [];
  for (const [id, entry] of entries) {
    if (trace.positions.has(id)) {
      before.set(id, unrecorded);
      unrecorded = [];
    } else unrecorded.push(entry);
  }
  return [
    ...ordered.flatMap(([id]) => [...before.get(id), entries.get(id)]),
    ...unrecorded,
  ];
}
