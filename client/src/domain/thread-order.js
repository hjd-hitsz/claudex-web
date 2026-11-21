import { resourceTarget } from "../../../shared/backend-identity.mjs";
import { titleOf } from "./format.js";
export const threadTime = (thread, running = false) =>
  (isArchivedThread(thread)
    ? thread.updatedAt
    : running
      ? thread.startedAt
      : thread.completedAt) ??
  thread.createdAt ??
  0;
export const PROJECTLESS_SOURCE = "claudex-web-projectless";

export function isArchivedThread(thread) {
  return Boolean(
    thread?.archived || thread?.path?.includes("/archived_sessions/"),
  );
}

export function sortThreads(threads, active = {}) {
  return threads.slice().sort((a, b) => {
    const aRunning = Boolean(active[a.id]);
    const bRunning = Boolean(active[b.id]);
    return (
      Number(bRunning) - Number(aRunning) ||
      threadTime(b, bRunning) - threadTime(a, aRunning) ||
      a.id.localeCompare(b.id)
    );
  });
}

function latestTime(first, second) {
  if (first == null) return second ?? null;
  return second == null ? first : Math.max(first, second);
}

export function mergeThreadTimes(thread, times) {
  return {
    ...thread,
    startedAt: latestTime(thread.startedAt, times?.startedAt),
    completedAt: latestTime(thread.completedAt, times?.completedAt),
  };
}

export function threadGroupPath(thread, projects, directories, root) {
  if (typeof thread.folderPath === "string") return thread.folderPath;
  if (!thread.cwd) return "";
  if (thread.projectId || projects.includes(thread.cwd)) return thread.cwd;
  const roots = Array.isArray(root) ? root : [root];
  const matchedRoot = roots.find(
    (entry) => entry && thread.cwd.startsWith(entry + "/"),
  );
  const workspace = matchedRoot ? thread.cwd.slice(matchedRoot.length + 1) : "";
  const webProjectless =
    /^chat-[A-Za-z0-9]{6}$/.test(workspace) &&
    ([PROJECTLESS_SOURCE, "codex-web-projectless"].includes(
      thread.threadSource,
    ) ||
      // 列表响应可能省略来源标记，通过网页创建者和专用自动目录恢复分类。
      (thread.threadSource == null &&
        ["claudex_web", "codex_lan_web"].includes(thread.originator)));
  return directories[thread.id] === thread.cwd || webProjectless
    ? ""
    : thread.cwd;
}

export function projectGroups(
  threads,
  projects,
  pins,
  projectlessDirectories = {},
  projectlessRoot = "",
  projectOrder = [],
  active,
) {
  const groups = new Map(
    ["", ...projectOrder, ...projects].map((path) => [path, []]),
  );
  const times = new Map();
  const positions = new Map(projectOrder.map((path, index) => [path, index]));
  for (const thread of sortThreads(threads, active)) {
    const path = threadGroupPath(
      thread,
      projects,
      projectlessDirectories,
      projectlessRoot,
    );
    if (!groups.has(path)) groups.set(path, []);
    times.set(path, Math.max(times.get(path) || 0, threadTime(thread)));
    if (!pins.includes(thread.id)) groups.get(path).push(thread);
  }
  return [...groups].sort(
    ([a], [b]) =>
      Number(!a) - Number(!b) ||
      Number(projects.includes(b)) - Number(projects.includes(a)) ||
      (positions.get(a) ?? -1) - (positions.get(b) ?? -1) ||
      (times.get(b) || 0) - (times.get(a) || 0) ||
      a.localeCompare(b),
  );
}

export function sidebarProjectGroups(state, { includePinned = false } = {}) {
  return projectGroups(
    state.threads,
    state.projects,
    includePinned ? [] : state.pins,
    state.projectlessDirectories,
    state.projectlessRoots.length
      ? state.projectlessRoots
      : state.projectlessRoot,
    state.projectOrder ?? [],
    state.active,
  );
}

// 先读取所有对话的轮次时间再排序，确保最近有活动的对话能进入第一页。
export function createThreadOrdering(rpc) {
  const cache = new Map();
  const observed = new Map();

  function observe(threadId, turn) {
    const previous = observed.get(threadId) ?? {};
    observed.set(
      threadId,
      mergeThreadTimes(previous, {
        startedAt: Number.isFinite(turn.startedAt) ? turn.startedAt : null,
        completedAt:
          turn.status !== "inProgress" && Number.isFinite(turn.completedAt)
            ? turn.completedAt
            : null,
      }),
    );
    cache.delete(threadId);
  }

  function apply(thread) {
    if (!thread) return thread;
    return mergeThreadTimes(thread, observed.get(thread.id));
  }

  async function activity(thread) {
    const existing = cache.get(thread.id);
    if (existing?.updatedAt === thread.updatedAt) return existing.promise;
    const entry = { updatedAt: thread.updatedAt };
    entry.promise = (async () => {
      let cursor;
      let completedAt = null;
      let startedAt = null;
      do {
        const page = await rpc("thread/turns/list", {
          threadId: thread.id,
          limit: 100,
          sortDirection: "desc",
          itemsView: "notLoaded",
          ...(cursor ? { cursor } : {}),
        });
        for (const turn of page.data) {
          if (Number.isFinite(turn.startedAt))
            startedAt = latestTime(startedAt, turn.startedAt);
          if (turn.status !== "inProgress" && Number.isFinite(turn.completedAt))
            completedAt = latestTime(completedAt, turn.completedAt);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return { startedAt, completedAt };
    })();
    cache.set(thread.id, entry);
    try {
      return await entry.promise;
    } catch (error) {
      if (cache.get(thread.id) === entry) cache.delete(thread.id);
      throw error;
    }
  }

  async function hydrate(threads) {
    const result = new Array(threads.length);
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, threads.length) }, async () => {
        while (index < threads.length) {
          const position = index++;
          const thread = threads[position];
          const times = await activity(thread).catch(() => null);
          const merged = apply(mergeThreadTimes(thread, times));
          observed.set(thread.id, {
            completedAt: merged.completedAt,
            startedAt: merged.startedAt,
          });
          result[position] = merged;
        }
      }),
    );
    return sortThreads(result.map(apply));
  }

  async function list(
    params,
    { onBackendErrors, onPage, isCurrent = () => true } = {},
  ) {
    const threads = new Map();
    const errors = new Map();
    let cursor;
    do {
      const page = await rpc("thread/list", {
        ...params,
        limit: 100,
        sortKey: params.archived ? "updated_at" : "created_at",
        sortDirection: "desc",
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrent()) return [];
      for (const error of page.backendErrors || [])
        errors.set(error.backendId, error);
      for (const thread of page.data) threads.set(thread.id, thread);
      cursor = page.nextCursor;
      if (page.data.length) onPage?.([...threads.values()]);
    } while (cursor);
    onBackendErrors?.([...errors.values()]);
    const data = [...threads.values()];
    return params.archived ? data : hydrate(data);
  }

  function forget(id) {
    cache.delete(id);
    observed.delete(id);
  }

  return { list, hydrate, observe, apply, forget };
}

// Failed backends retain the records already visible in the same list scope.
export function preserveFailedBackendThreads(
  records,
  previous,
  errors,
  params,
  previousParams,
) {
  const failed = new Set(errors.map((error) => error.backendId));
  const search = params.searchTerm?.toLocaleLowerCase();
  const sameSearch =
    previousParams &&
    previousParams.searchTerm === params.searchTerm &&
    Boolean(previousParams.archived) === Boolean(params.archived);
  const retained = previous.filter(
    (thread) =>
      failed.has(resourceTarget(thread.id).backendId) &&
      isArchivedThread(thread) === Boolean(params.archived) &&
      (!search ||
        sameSearch ||
        titleOf(thread).toLocaleLowerCase().includes(search)),
  );
  return sortThreads([
    ...new Map(
      [...retained, ...records].map((thread) => [thread.id, thread]),
    ).values(),
  ]);
}
