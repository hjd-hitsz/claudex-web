import { createGoals } from "./goals.js";
import { createBackends } from "./backends.js";
import { resourceTarget } from "../../../shared/backend-identity.mjs";
import { createAppState } from "./state.js";
import { createRpcClient } from "../infrastructure/rpc-client.js";
import { isP2pPage } from "../infrastructure/p2p-access.js";
import { createP2pSocket } from "../infrastructure/p2p-socket.js";
import { createModelPreferences } from "./models.js";
import { createThreadRecords } from "./thread-records.js";
import { createThreadNavigation } from "./thread-navigation.js";
import { createThreadCatalog } from "./thread-catalog.js";
import { createMessages } from "./messages.js";
import { createAccount } from "./account.js";
import { createCompaction } from "./compaction.js";
import { createEvents } from "./events.js";
import { createConnection } from "./connection.js";
import { createSession } from "./session.js";
import { createTranslationSettings } from "./translation.js";
import { createNotifications } from "./notifications.js";
import { createErrorFeedback, rpcFeedbackKey } from "./error-feedback.js";

// 依赖在此处组装；控制器通过显式接口协作，各自持有请求版本和生命周期状态。
export function createApplication() {
  const p2p = isP2pPage();
  const store = createAppState();
  const { get, set } = store;
  const listeners = new Set();
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const onEvent = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const feedback = createErrorFeedback({
    get,
    set,
    opening: () => navigation.opening,
  });
  const { report } = feedback;
  let noticeRevision = 0;
  function notice(text) {
    const revision = ++noticeRevision;
    set({ notice: text });
    setTimeout(() => {
      if (noticeRevision === revision && get().notice) set({ notice: "" });
    }, 4000);
  }
  function copy(text) {
    return feedback
      .track("clipboard-copy", async () => {
        if (navigator.clipboard?.writeText)
          await navigator.clipboard.writeText(text);
        else {
          const input = document.createElement("textarea");
          input.value = text;
          input.style.position = "fixed";
          input.style.opacity = "0";
          document.body.append(input);
          input.select();
          const ok = document.execCommand("copy");
          input.remove();
          if (!ok) throw new Error("浏览器未允许复制，请长按文本选择复制。");
        }
        notice("已复制");
      })
      .catch(report);
  }
  function openSubAgent(agent) {
    set({
      panel: "agent",
      panelAgent: { ...agent, parentId: get().current?.id },
      contextOpen: true,
    });
  }
  let skillsRevision = 0;
  async function loadSkills() {
    const revision = ++skillsRevision;
    const { cwd, backendId, providerId, current } = get();
    const result = await rpc("skills/list", {
      cwds: [cwd],
      cwd,
      backendId,
      providerId,
      ...(current?.id && { threadId: current.id }),
    });
    if (
      revision !== skillsRevision ||
      get().cwd !== cwd ||
      get().backendId !== backendId ||
      get().providerId !== providerId ||
      get().current?.id !== current?.id
    )
      return;
    set({
      skills: result.data.flatMap((entry) => entry.skills || []),
      nativeCommands: result.commands || [],
      nativeAgents: result.agents || [],
    });
  }
  const transport = createRpcClient({
    isConnected: () => get().connected,
    authenticated: () => get().auth?.authenticated,
    requestContext: () => ({ opening: navigation.opening }),
    onNotification: (message) => connection.onNotification(message),
    onRequest: (message) => connection.onRequest(message),
    onResponse: (request, message, error) =>
      connection.onResponse(request, message, error),
    ...(p2p && {
      createSocket: () => createP2pSocket(session.p2pToken),
      onOpen: () => session.p2pConnected(),
    }),
    onClose: (event, socket) => {
      if (p2p && (!get().auth?.authenticated || event.code === 4401))
        session.p2pRejected(event);
      else connection.onClose(event, socket);
    },
  });
  const rpc = (method, params = {}, timeout) => {
    const request = (params) =>
      feedback.track(rpcFeedbackKey(method, params), () =>
        transport.rpc(method, params, timeout),
      );
    if (!get().backends.length) return request(params);
    const backendId =
      params.backendId ||
      (params.threadId
        ? resourceTarget(params.threadId).backendId
        : get().backendId);
    const global =
      method === "thread/list" ||
      method.startsWith("lan/backends/") ||
      method.startsWith("lan/terminal/") ||
      method.startsWith("lan/providers/");
    return request({ ...(!global && { backendId }), ...params });
  };
  const goals = createGoals({
    get,
    set,
    rpc,
    navigation: { ensureThread: () => navigation.ensureThread() },
    onEvent,
  });
  const codeLineRequests = new Map();
  let codeLineConnection;
  async function findCodeLine(line) {
    const { cwd, backendId, providerId, current } = get();
    const connection = transport.connection;
    if (!cwd) return [];
    if (codeLineConnection !== connection) {
      codeLineRequests.clear();
      codeLineConnection = connection;
    }
    const key = JSON.stringify([cwd, backendId, providerId, current?.id, line]);
    let request = codeLineRequests.get(key);
    if (!request) {
      request = rpc(
        "lan/workspace/codeLine",
        { cwd, backendId, ...(current?.id && { threadId: current.id }), line },
        2500,
      ).finally(() => {
        if (codeLineRequests.get(key) === request) codeLineRequests.delete(key);
      });
      codeLineRequests.set(key, request);
    }
    const result = await request;
    const state = get();
    return transport.connection === connection &&
      state.cwd === cwd &&
      state.backendId === backendId &&
      state.providerId === providerId &&
      state.current?.id === current?.id
      ? result?.matches
      : [];
  }
  const models = createModelPreferences({ get, set, rpc, transport, report });
  const backends = createBackends({
    transport,
    get,
    set,
    rpc,
    models,
    report,
    onSelectionChanged: () => account.handle({ method: "account/updated" }),
  });
  const records = createThreadRecords({ get, set, rpc });
  const navigation = createThreadNavigation({
    get,
    set,
    rpc,
    transport,
    models,
    records,
    getConnectionRevision: () => connection.revision,
    activateThreadBackend: backends.activateThreadBackend,
    selectProvider: backends.selectProvider,
  });
  async function selectBackend(id) {
    if (
      get().busy ||
      get().loading ||
      get().backendId === id ||
      !get().backends.some((b) => b.id === id && b.enabled)
    )
      return;
    if (get().current)
      navigation.newChat(undefined, {
        reuseDirectory: true,
        applyModelSelection: false,
      });
    await backends.activateBackend(id);
  }
  const catalog = createThreadCatalog({
    get,
    set,
    rpc,
    records,
    navigation,
    report,
    notice,
  });
  const messages = createMessages({
    setThreadMode: store.setThreadMode,
    get,
    set,
    rpc,
    transport,
    navigation,
    catalog,
    records,
    models,
    feedback,
  });
  const account = createAccount({ get, set, rpc, transport });
  const compaction = createCompaction({
    get,
    set,
    rpc,
    transport,
    navigation,
    records,
    hasTracking: () => connection.hasTracking(),
  });
  const translation = createTranslationSettings({
    get,
    set,
    subscribe: store.subscribe,
  });
  const notifications = createNotifications({
    get,
    set,
    subscribe: store.subscribe,
    navigation,
    rpc,
  });
  const events = createEvents({
    get,
    set,
    records,
    catalog,
    messages,
    account,
    report,
    notice,
    notifications,
  });
  const connection = createConnection({
    get,
    set,
    rpc,
    transport,
    models,
    records,
    navigation,
    catalog,
    messages,
    account,
    compaction,
    events,
    emit,
    report,
    loadSkills,
    activateBackend: backends.activateBackend,
    getSession: () => session,
  });
  const session = createSession({
    get,
    set,
    transport,
    connection,
    p2p,
    resetFeedback: feedback.reset,
  });
  return {
    store,
    rpc,
    onEvent,
    findCodeLine,
    report,
    trackFeedback: feedback.track,
    notice,
    copy,
    openSubAgent,
    loadSkills,
    setReadingThread: records.setReadingThread,
    selectModel: models.selectModel,
    selectEffort: models.selectEffort,
    syncProjectModels: models.syncProjectModels,
    refreshUsage: account.refreshUsage,
    setCompletionNotifications: notifications.setEnabled,
    startNotifications: notifications.start,
    startTranslationSettings: translation.start,
    setThinkingTranslation: translation.setEnabled,
    ...goals,
    ...backends,
    ...navigation,
    selectBackend,
    ...catalog,
    ...messages,
    ...compaction,
    ...session,
  };
}
