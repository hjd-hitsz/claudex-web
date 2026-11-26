export async function listBackendThreads(
  params,
  { instances, instance, call },
) {
  const ids = [...instances.values()]
    .filter((i) => i.backend.enabled)
    .map((i) => i.backend.id);
  const position = params.cursor
    ? JSON.parse(decodeURIComponent(params.cursor))
    : { index: 0 };
  const errors = [];
  while (position.index < ids.length) {
    const backendId = ids[position.index];
    try {
      const entry = instance(backendId);
      const page = await call(entry, "thread/list", {
        ...params,
        cursor: position.cursor,
      });
      const next = page.nextCursor
        ? { ...position, cursor: page.nextCursor }
        : { index: position.index + 1 };
      return {
        ...page,
        backendErrors: errors,
        nextCursor:
          next.index < ids.length
            ? encodeURIComponent(JSON.stringify(next))
            : null,
      };
    } catch (error) {
      errors.push({ backendId, message: error.message });
      position.index++;
      delete position.cursor;
    }
  }
  return { data: [], nextCursor: null, backendErrors: errors };
}
