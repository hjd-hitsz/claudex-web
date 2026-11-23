import { resourceTarget } from "../../../shared/backend-identity.mjs";
import {
  isArchivedThread,
  mergeThreadTimes,
  projectGroups,
  PROJECTLESS_SOURCE,
  preserveFailedBackendThreads,
  sortThreads,
  threadGroupPath,
} from "../domain/thread-order.js";
import { nextForkTitle } from "../domain/fork-title.js";
import { saved, persist } from "../infrastructure/storage.js";
import { RpcConnectionError } from "../infrastructure/rpc-client.js";
import { titleOf } from "../domain/format.js";
export function createThreadCatalog({
  get,
  set,
  rpc,
  records,
  navigation,
  report,
  notice,
}) {
  let listing = 0;
  let listedScope;
  let pendingForks = saved("cx-pending-forks", []);
  async function listThreads(params, options) {
    const threads = await records.threadOrdering.list(params, options);
    return sortThreads(threads, get().active);
  }
  async function loadThreads({ archived = get().archived } = {}) {
    const epoch = ++listing;
    const scopeChanged = archived !== get().archived;
    set({
      threadListLoading: true,
      ...(scopeChanged && { archived, threads: [], threadListErrors: [] }),
    });
    try {
      await refreshThreadList(epoch);
    } catch (error) {
      if (epoch !== listing || error instanceof RpcConnectionError) return;
      set({ threadListErrors: [{ message: error.message }] });
      throw error;
    } finally {
      if (epoch === listing) set({ threadListLoading: false });
    }
  }
  async function refreshThreadList(epoch) {
    const revision = records.nameRevision;
    const params = {
      archived: get().archived,
      ...(get().search ? { searchTerm: get().search } : {}),
    };
    const isCurrent = () => epoch === listing;
    const previous = get().threads;
    const visibleRecords = (threads) =>
      threads
        .filter((thread) => !records.deletedThreads.has(thread.id))
        .map((thread) => records.preserveThreadName(thread, revision));
    let errors = [];
    const [loaded, projectless] = await Promise.all([
      listThreads(params, {
        isCurrent,
        onBackendErrors: (value) => {
          errors = value;
        },
        ...(params.archived &&
          !previous.length && {
            onPage: (threads) => set({ threads: visibleRecords(threads) }),
          }),
      }),
      rpc("lan/projectless/read").catch(() => ({ directories: {} })),
    ]);
    if (!isCurrent()) return;
    const data = preserveFailedBackendThreads(
      loaded,
      previous,
      errors,
      params,
      listedScope,
    );
    let extra = [];
    if (!params.archived) {
      pendingForks = pendingForks.filter(
        (id) => !data.some((t) => t.id === id),
      );
      persist("cx-pending-forks", pendingForks);
      extra = await Promise.all(
        pendingForks.map((id) =>
          rpc("thread/read", { threadId: id, includeTurns: false })
            .then((r) => r.thread)
            .catch(() => null),
        ),
      );
    }
    if (!isCurrent()) return;
    const visible = extra.filter(
      (t) =>
        t &&
        !records.deletedThreads.has(t.id) &&
        isArchivedThread(t) === params.archived &&
        (!get().search || titleOf(t).includes(get().search)),
    );
    const threads = [...visible, ...data];
    if (
      get().current &&
      !params.archived &&
      !isArchivedThread(get().current) &&
      !get().search &&
      !threads.some((t) => t.id === get().current.id)
    )
      threads.unshift(get().current);
    const failed = new Set(errors.map((error) => error.backendId));
    const unique = [
      ...new Map(threads.map((thread) => [thread.id, thread])).values(),
    ].filter((thread) => !records.deletedThreads.has(thread.id));
    const hydrated = params.archived
      ? unique
      : [
          ...(await records.threadOrdering.hydrate(
            unique.filter(
              (thread) => !failed.has(resourceTarget(thread.id).backendId),
            ),
          )),
          ...unique.filter((thread) =>
            failed.has(resourceTarget(thread.id).backendId),
          ),
        ];
    if (!isCurrent()) return;
    const sorted = visibleRecords(hydrated);
    const state = get();
    const listed = sorted.find((thread) => thread.id === state.current?.id);
    const current = listed
      ? mergeThreadTimes({ ...state.current, ...listed }, state.current)
      : state.current;
    const projectlessRoots = state.projectlessRoots?.length
      ? state.projectlessRoots
      : state.projectlessRoot;
    listedScope = params;
    set({
      threadListErrors: errors,
      projectlessDirectories: projectless.directories,
      ...(!params.archived && {
        projectOrder: [
          ...projectGroups(
            sorted,
            get().projects,
            get().pins,
            projectless.directories,
            projectlessRoots,
          )
            .map(([path]) => path)
            .filter((path) => !get().projectOrder?.includes(path)),
          ...(get().projectOrder || []),
        ],
      }),
      threads: sorted,
      current,
      ...(current && {
        projectless: !threadGroupPath(
          current,
          state.projects,
          projectless.directories,
          projectlessRoots,
        ),
      }),
    });
  }
  async function rename(thread, name) {
    await rpc("thread/name/set", { threadId: thread.id, name });
    records.updateThreadName(thread.id, name);
    await loadThreads();
  }
  async function archive(thread) {
    const restoring = isArchivedThread(thread);
    await rpc(restoring ? "thread/unarchive" : "thread/archive", {
      threadId: thread.id,
    });
    if (get().current?.id === thread.id) navigation.newChat();
    if (restoring) {
      pendingForks = [...new Set([...pendingForks, thread.id])];
      persist("cx-pending-forks", pendingForks);
      await Promise.all([
        loadThreads({ archived: false }),
        navigation.openThread(thread.id),
      ]);
      return;
    }
    await loadThreads();
  }
  function syncArchivedThread(id) {
    pendingForks = pendingForks.filter((value) => value !== id);
    persist("cx-pending-forks", pendingForks);
    if ((get().threadAccess?.threadId || get().current?.id) === id)
      navigation.newChat();
    else if (get().current?.id === id) set({ current: null, items: [] });
    if (localStorage.getItem("cx-current") === id)
      localStorage.removeItem("cx-current");
    const active = { ...get().active };
    delete active[id];
    const unreadCompletions = { ...get().unreadCompletions };
    delete unreadCompletions[id];
    const compactions = { ...get().compactions };
    delete compactions[id];
    set({
      active,
      unreadCompletions,
      compactions,
      threads: get().archived
        ? get().threads
        : get().threads.filter((thread) => thread.id !== id),
      questions: get().questions.filter(
        (question) => question.params?.threadId !== id,
      ),
      modal: get().modal?.thread?.id === id ? null : get().modal,
    });
    loadThreads().catch(() => {});
  }
  function forgetThread(id) {
    records.forget(id);
    pendingForks = pendingForks.filter((value) => value !== id);
    persist("cx-pending-forks", pendingForks);
    const pins = get().pins.filter((value) => value !== id);
    persist("cx-pins", pins);
    localStorage.removeItem("cx-draft-" + id);
    const undoneFiles = Object.fromEntries(
      Object.entries(get().undoneFiles).filter(
        ([key]) => JSON.parse(key)[0] !== id,
      ),
    );
    persist("cx-undone-files", undoneFiles);
    if (localStorage.getItem("cx-current") === id)
      localStorage.removeItem("cx-current");
    if (get().current?.id === id) navigation.newChat();
    const patch = {};
    for (const key of [
      "active",
      "unreadCompletions",
      "compactions",
      "turns",
      "turnTimings",
      "diffs",
      "turnDiffs",
      "plans",
      "tokenUsage",
    ]) {
      patch[key] = { ...get()[key] };
      delete patch[key][id];
    }
    set({
      ...patch,
      undoneFiles,
      pins,
      threads: get().threads.filter((thread) => thread.id !== id),
      questions: get().questions.filter(
        (question) => question.params?.threadId !== id,
      ),
      modal: get().modal?.thread?.id === id ? null : get().modal,
    });
  }
  async function deleteThread(thread) {
    await rpc("thread/delete", { threadId: thread.id });
    forgetThread(thread.id);
    notice("对话已删除");
    await loadThreads().catch(report);
  }
  async function fork(thread = get().current, lastTurnId) {
    const opening = navigation.opening;
    const revision = records.nameRevision;
    const backendId = resourceTarget(thread.id).backendId;
    const selection =
      get().current?.id === thread.id
        ? { model: get().model, reasoningEffort: get().effort }
        : rpc("thread/read", { threadId: thread.id, includeTurns: false }).then(
            (result) => result.thread,
          );
    async function familyPageList(archived) {
      const entries = [];
      let cursor;
      do {
        const page = await rpc("thread/list", {
          backendId,
          archived,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        entries.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return entries;
    }
    const [sourceSettings, live, archived] = await Promise.all([
      selection,
      familyPageList(false),
      familyPageList(true),
    ]);
    const threads = [...live, ...archived].map((record) =>
      records.preserveThreadName(record, revision),
    );
    const source = threads.find((record) => record.id === thread.id) || thread;
    const name = nextForkTitle(source, threads);
    const r = await rpc("thread/fork", {
      threadId: thread.id,
      ...(sourceSettings.model && { model: sourceSettings.model }),
      ...(sourceSettings.reasoningEffort && {
        config: { model_reasoning_effort: sourceSettings.reasoningEffort },
      }),
      excludeTurns: true,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...(thread.threadSource === PROJECTLESS_SOURCE
        ? { threadSource: PROJECTLESS_SOURCE }
        : {}),
    });
    pendingForks = [...new Set([...pendingForks, r.thread.id])];
    persist("cx-pending-forks", pendingForks);
    await rpc("thread/name/set", {
      threadId: r.thread.id,
      name,
    });
    records.updateThreadName(r.thread.id, name);
    notice("已创建对话分支");
    if (opening === navigation.opening)
      await navigation.openThread(r.thread.id, {
        forkResult: { ...r, thread: { ...r.thread, name } },
      });
    await loadThreads();
  }
  function applyThreadFolder(thread) {
    const known =
      get().threads.find((entry) => entry.id === thread.id) ||
      (get().current?.id === thread.id ? get().current : null);
    if ((known?.folderRevision || 0) > (thread.folderRevision || 0)) return;
    const update = (entry) =>
      entry?.id === thread.id
        ? {
            ...entry,
            folderPath: thread.folderPath,
            folderRevision: thread.folderRevision,
            cwd: thread.cwd,
          }
        : entry;
    const pins = get().pins.filter((id) => id !== thread.id);
    persist("cx-pins", pins);
    set({
      pins,
      threads: get().threads.map(update),
      current: update(get().current),
      ...(get().current?.id === thread.id && {
        cwd: thread.cwd,
        projectless: !thread.folderPath,
        projectlessCwd: null,
      }),
    });
  }
  async function moveThreadToFolder(id, folderPath) {
    const { thread } = await rpc("lan/thread/move", {
      threadId: id,
      folderPath,
    });
    if (!records.deletedThreads.has(id)) applyThreadFolder(thread);
  }
  function pin(id) {
    const pins = get().pins.includes(id)
      ? get().pins.filter((x) => x !== id)
      : [...get().pins, id];
    set({ pins });
    persist("cx-pins", pins);
  }
  function addProject(path) {
    if (!get().projects.includes(path)) {
      const projects = [...get().projects, path];
      set({
        projects,
        ...(get().projectOrder && {
          projectOrder: [
            path,
            ...get().projectOrder.filter((value) => value !== path),
          ],
        }),
      });
      persist("cx-projects", projects);
    }
    navigation.newChat(path);
  }
  function toggleProjectPin(path) {
    if (!path) return;
    const projects = get().projects.includes(path)
      ? get().projects.filter((value) => value !== path)
      : [...get().projects, path];
    persist("cx-projects", projects);
    set({ projects });
  }
  return {
    listThreads,
    loadThreads,
    rename,
    archive,
    syncArchivedThread,
    forgetThread,
    deleteThread,
    fork,
    pin,
    moveThreadToFolder,
    applyThreadFolder,
    addProject,
    toggleProjectPin,
  };
}
