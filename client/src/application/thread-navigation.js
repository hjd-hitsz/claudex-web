import { backgroundNoticeKeys } from "../domain/background-results.js";
import {
  newDraftKey,
  readNewDraft,
} from "../infrastructure/backend-storage.js";
import { resourceTarget } from "../../../shared/backend-identity.mjs";
import { backendEnabled } from "../domain/backend-visibility.js";
import { canUseNativeDelegation } from "../domain/delegation.js";
import { compatibleEffort } from "../domain/model-preferences.js";
import { resolveServiceTier } from "../domain/service-tier.js";
import {
  isArchivedThread,
  mergeThreadTimes,
  threadGroupPath,
  PROJECTLESS_SOURCE,
} from "../domain/thread-order.js";
import {
  createThreadHistoryLoader,
  prefetchThreadItems,
} from "./history-page.js";
import { createThreadAttachmentDrafts } from "./thread-attachment-drafts.js";
export function createThreadNavigation({
  get,
  set,
  rpc,
  transport,
  models,
  records,
  getConnectionRevision,
  activateBackend = async () => {},
  selectProvider = () => {},
  report = () => {},
}) {
  let opening = 0;
  let historyRevision = 0;
  const { getAttachmentDraft, updateAttachmentDraft, assignNewThread } =
    createThreadAttachmentDrafts(get, set);
  function setProjectDirectory(cwd) {
    if (!get().loading) models.rememberModelSelection();
    set({
      cwd,
      projectless: false,
      projectlessCwd: null,
      ...models.projectModelSelection(cwd, false, models.defaults),
    });
  }
  function newChat(
    cwd = get().projectless ? "" : get().cwd,
    {
      reuseDirectory = false,
      applyModelSelection = true,
      backendId = get().backendId,
    } = {},
  ) {
    const sameProject = (get().projectless ? "" : get().cwd) === (cwd || "");
    const selection =
      applyModelSelection && get().model && !get().loading
        ? {
            model: get().model,
            effort: compatibleEffort(
              get().effort,
              get().models.find((model) => model.model === get().model),
            ),
          }
        : null;
    if (applyModelSelection && !get().loading) models.rememberModelSelection();
    const projectlessCwd =
      reuseDirectory &&
      get().projectless &&
      (get().current || get().projectlessCwd)
        ? get().cwd
        : null;
    opening++;
    getAttachmentDraft();
    localStorage.removeItem("cx-current");
    set({
      current: null,
      delegationMode:
        get().delegationMode && canUseNativeDelegation({ ...get(), backendId }),
      mode: "default",
      items: [],
      cwd: cwd || projectlessCwd || get().defaultCwd,
      projectless: !cwd,
      projectlessCwd,
      ...(applyModelSelection
        ? sameProject && selection
          ? selection
          : models.projectModelSelection(cwd, !cwd, models.defaults)
        : { model: "", effort: "", serviceTier: null }),
      draft: readNewDraft(),
      attachments: getAttachmentDraft(null).attachments,
      error: "",
      loading: false,
      threadAccess: null,
      sidebar: false,
      contextOpen: false,
      panelFile: null,
    });
  }
  async function openThread(
    id,
    { preserveServiceTier = false, forkResult, refreshMetadata = false } = {},
  ) {
    if (!backendEnabled(get().backends, resourceTarget(id).backendId)) return;
    if (get().current && !get().loading) models.rememberModelSelection();
    const epoch = ++opening;
    const revision = records.nameRevision;
    const connection = transport.connection;
    const connectionRevision = getConnectionRevision();
    set({
      loading: true,
      error: "",
      threadAccess: { threadId: id, status: "loading" },
      sidebar: false,
      ...(get().current?.id !== id && {
        contextOpen: false,
        agyDelegateTo: undefined,
        panelFile: null,
      }),
    });
    try {
      const backendId = resourceTarget(id).backendId;
      const switchingBackend = get().backendId !== backendId;
      const usageSnapshot = { value: get().tokenUsage[id] };
      const created =
        connection === transport.connection &&
        connectionRevision === getConnectionRevision()
          ? forkResult
          : undefined;
      const read =
        created || rpc("thread/read", { threadId: id, includeTurns: false });
      const firstPage = prefetchThreadItems(
        rpc,
        id,
        get,
        records.turnRevisions,
      );
      const r = await read;
      if (epoch !== opening || records.deletedThreads.has(id)) return;
      const known = get().threads.find((thread) => thread.id === id);
      const thread = records.preserveThreadName(
        records.threadOrdering.apply(mergeThreadTimes(r.thread, known)),
        revision,
      );
      const cwd = thread.cwd || r.cwd;
      const providerId = thread.providerId || "";
      const model =
        thread.model || (switchingBackend ? "" : models.defaults.model);
      const refresh = refreshMetadata || switchingBackend || get().cwd !== cwd;
      const projectless = !threadGroupPath(
        thread,
        get().projects,
        get().projectlessDirectories,
        get().projectlessRoots?.length
          ? get().projectlessRoots
          : get().projectlessRoot,
      );
      getAttachmentDraft();
      if (backendId === "claude" && !switchingBackend)
        selectProvider(providerId);
      set({
        ...(isArchivedThread(thread) === get().archived && {
          threads: get().threads.some((t) => t.id === id)
            ? get().threads.map((t) =>
                t.id === id ? { ...t, name: thread.name } : t,
              )
            : [thread, ...get().threads],
        }),
        current: thread,
        ...(thread.tokenUsage &&
          get().tokenUsage[id] === usageSnapshot.value && {
            tokenUsage: { ...get().tokenUsage, [id]: thread.tokenUsage },
          }),
        providerId,
        attachments: getAttachmentDraft(id).attachments,
        cwd,
        projectless,
        projectlessCwd: null,
        model,
        effort: thread.reasoningEffort || "",
        items: [],
        draft: localStorage.getItem("cx-draft-" + id) || "",
      });
      if (refresh)
        activateBackend(backendId, { backendId, providerId, model }).catch(
          (error) => {
            if (epoch === opening) report(error);
          },
        );
      localStorage.setItem("cx-current", id);
      const ordering =
        !isArchivedThread(thread) &&
        records.threadOrdering.hydrate([r.thread]).then(([hydrated]) => {
          if (epoch !== opening || records.deletedThreads.has(id)) return;
          const update = (thread) =>
            thread?.id === id
              ? records.threadOrdering.apply(mergeThreadTimes(thread, hydrated))
              : thread;
          set({
            current: update(get().current),
            threads: get().threads.map(update),
          });
        });
      let access;
      const accessOptions = {
        preserveServiceTier,
        usageSnapshot,
        ...(backendId === "codex" && { forkResult: created }),
      };
      await loadHistory(epoch, {
        firstPage: r.thread.status?.type === "active" ? undefined : firstPage,
        onFirstPage: () => {
          set({ loading: false });
          access = refreshThreadAccess(accessOptions);
        },
      });
      await ordering;
      if (epoch !== opening || records.deletedThreads.has(id)) return;
      set({ loading: false });
      await (access || refreshThreadAccess(accessOptions));
    } catch (e) {
      if (epoch === opening)
        set({
          threadAccess: {
            threadId: id,
            status: "loadError",
            message: e.message,
          },
        });
    } finally {
      if (epoch === opening) set({ loading: false });
    }
  }
  async function refreshThreadAccess({
    preserveServiceTier = true,
    background = false,
    usageSnapshot = { value: get().tokenUsage[get().current?.id] },
    forkResult,
  } = {}) {
    if (
      get().loading ||
      (get().threadAccess?.status === "checking" && !background)
    )
      return false;
    if (get().threadAccess?.status === "loadError")
      return openThread(get().threadAccess.threadId, { preserveServiceTier });
    const id = get().current?.id;
    if (!id) return false;
    if (isArchivedThread(get().current)) {
      set({ threadAccess: { threadId: id, status: "archived" } });
      return false;
    }
    if (get().current.secretaryContinuationRequired) {
      set({ threadAccess: { threadId: id, status: "secretaryContinuation" } });
      return false;
    }
    const epoch = opening;
    const connection = transport.connection;
    const revision = getConnectionRevision();
    const turnRevision = records.turnRevisions.get(id);
    const selectionRevision = models.revision;
    const selection = {
      model: get().model,
      effort: get().effort,
      serviceTier: get().serviceTier,
      mode: get().mode,
      delegationMode: get().delegationMode,
    };
    const checking = {
      threadId: id,
      status: "checking",
      background:
        background &&
        (get().threadAccess?.status === "ready" ||
          get().threadAccess?.background === true),
    };
    const current = () =>
      epoch === opening &&
      connection === transport.connection &&
      revision === getConnectionRevision() &&
      get().connected &&
      get().threadAccess === checking;
    set({ threadAccess: checking });
    let resumed = false;
    try {
      // 原生 Codex 分支创建已加载对话并返回同一组模型设置。
      const settings =
        forkResult ||
        (await rpc("thread/resume", { threadId: id, excludeTurns: true }));
      if (!current()) return false;
      resumed = true;
      const modelSelection = {
        model: settings.model || get().model,
        effort:
          settings.reasoningEffort ?? forkResult?.thread.reasoningEffort ?? "",
      };
      set({
        threadAccess: { threadId: id, status: "ready" },
        ...(get().delegationMode === selection.delegationMode && {
          delegationMode: settings.thread?.delegationMode === true,
        }),
        ...(settings.thread?.tokenUsage &&
          get().tokenUsage[id] === usageSnapshot.value && {
            tokenUsage: {
              ...get().tokenUsage,
              [id]: settings.thread.tokenUsage,
            },
          }),
        ...(get().mode === selection.mode &&
          settings.collaborationMode?.mode && {
            mode: settings.collaborationMode.mode,
          }),
        ...(selectionRevision === models.revision &&
          get().model === selection.model &&
          get().effort === selection.effort &&
          modelSelection),
        ...(!preserveServiceTier &&
          get().serviceTier === selection.serviceTier && {
            serviceTier: settings.serviceTier ?? null,
          }),
      });
    } catch (error) {
      if (!current()) return false;
      set({
        threadAccess: {
          threadId: id,
          status:
            records.turnRevisions.get(id) !== turnRevision
              ? "ready"
              : /already has an active writer/i.test(error.message)
                ? "blocked"
                : "error",
          message: error.message,
        },
      });
    }
    const access = get().threadAccess;
    rpc("thread/turns/list", { threadId: id, limit: 20, itemsView: "summary" })
      .then((page) => {
        if (
          epoch !== opening ||
          connection !== transport.connection ||
          revision !== getConnectionRevision() ||
          !get().connected ||
          get().threadAccess !== access
        )
          return;
        const active = { ...get().active };
        const running = page.data.find((t) => t.status === "inProgress");
        const unchanged = records.turnRevisions.get(id) === turnRevision;
        if (unchanged) {
          if (resumed && running) active[id] = running.id;
          else if (
            page.data.some(
              (turn) => turn.id === active[id] && turn.status !== "inProgress",
            )
          )
            delete active[id];
        }
        const live = get().turns[id] || [];
        const liveIds = new Set(live.map((turn) => turn.id));
        set({
          turns: {
            ...get().turns,
            [id]: unchanged
              ? page.data
              : [...live, ...page.data.filter((turn) => !liveIds.has(turn.id))],
          },
          active,
        });
      })
      .catch(() => {});
    return access.status === "ready";
  }
  const loadHistory = createThreadHistoryLoader({
    rpc,
    get,
    set,
    transport,
    getConnectionRevision,
    historyRevision: () => historyRevision,
    opening: () => opening,
  });
  async function refreshBackgroundResults(threadId, noticeKeys) {
    if (get().current?.id !== threadId) return [];
    const epoch = opening;
    const history = historyRevision;
    const connection = getConnectionRevision();
    const current = () =>
      epoch === opening &&
      history === historyRevision &&
      connection === getConnectionRevision() &&
      get().connected &&
      get().current?.id === threadId;
    const state = get();
    const timings = state.turnTimings[threadId] ?? {};
    const statuses = new Map(
      (state.turns[threadId] ?? []).map((turn) => [turn.id, turn.status]),
    );
    const present = new Set(
      state.items
        .filter((item) =>
          ["completed", "failed", "interrupted"].includes(
            timings[item.turnId]?.status ?? statuses.get(item.turnId),
          ),
        )
        .flatMap(backgroundNoticeKeys),
    );
    const missing = new Set(noticeKeys.filter((id) => !present.has(id)));
    if (!missing.size) return noticeKeys;
    const page = await rpc("thread/turns/list", {
      threadId,
      itemsView: "full",
      limit: 10,
    });
    if (!current()) return [];
    const finishedTurns = page.data.filter(
      (turn) =>
        turn.status !== "inProgress" &&
        (turn.items || []).some((item) =>
          backgroundNoticeKeys(item).some((id) => missing.has(id)),
        ),
    );
    if (finishedTurns.length) {
      await loadHistory(epoch);
      if (!current()) return [];
      records.recordTurnTimings(threadId, finishedTurns);
    }
    const finished = finishedTurns.flatMap((turn) =>
      (turn.items || []).flatMap(backgroundNoticeKeys),
    );
    return noticeKeys.filter((id) => present.has(id) || finished.includes(id));
  }
  async function ensureThread(delegationMode = get().delegationMode) {
    if (get().current) return get().current;
    const epoch = opening;
    const { projectless, model, serviceTier, providerId } = get();
    let cwd = get().cwd;
    if (projectless) {
      if (!get().projectlessCwd) {
        const workspace = await rpc("lan/projectless/prepare");
        if (epoch !== opening)
          throw new Error("对话已切换，请在当前对话重新发送消息。");
        set({
          cwd: workspace.cwd,
          projectlessCwd: workspace.cwd,
          projectlessRoot: workspace.root,
        });
      }
      cwd = get().projectlessCwd;
    }
    const r = await rpc("thread/start", {
      cwd,
      model: model || undefined,
      providerId,
      ...(delegationMode &&
        canUseNativeDelegation(get()) && {
          delegationMode: true,
        }),
      serviceTier: resolveServiceTier(
        serviceTier,
        get().models.find((m) => m.model === model),
      ),
      ...(projectless ? { threadSource: PROJECTLESS_SOURCE } : {}),
    });
    if (epoch !== opening)
      throw new Error("对话已切换，请在当前对话重新发送消息。");
    localStorage.setItem("cx-draft-" + r.thread.id, get().draft);
    localStorage.removeItem(newDraftKey);
    assignNewThread(r.thread.id);
    set({
      current: r.thread,
      mode: get().mode,
      delegationMode: r.thread.delegationMode === true,
    });
    localStorage.setItem("cx-current", r.thread.id);
    return r.thread;
  }
  return {
    invalidateHistory: () => historyRevision++,
    setProjectDirectory,
    newChat,
    openThread,
    refreshThreadAccess,
    loadHistory,
    refreshBackgroundResults,
    ensureThread,
    getAttachmentDraft,
    updateAttachmentDraft,
    get opening() {
      return opening;
    },
  };
}
