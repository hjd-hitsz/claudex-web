import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createStorage } from "../storage.mjs";
import { createCompactions } from "../../compaction.mjs";
import { createProductMethods } from "../../bridge/product-methods.mjs";
import { assertConversationOperation } from "../../bridge/conversation-policy.mjs";
import { createWorkspace } from "../../workspace/service.mjs";
import { opencodeCapabilities } from "../../../../shared/backend-capabilities.mjs";
import { createOpenCodeSessions, modelRef } from "./sessions.mjs";
import { createOpenCodeCatalogue } from "./catalogue.mjs";
import { createOpenCodeQuestions } from "./questions.mjs";
import { createOpenCodeEvents } from "./events.mjs";
import { createOpenCodeTasks } from "./tasks.mjs";
import { createOpenCodeGoals } from "./goals.mjs";
import { createOpenCodeAccount } from "./account.mjs";
import { resolveOpenCode } from "./installation.mjs";
import { loadOpenCode } from "./runtime.mjs";
import { createCodexAccountSource } from "./codex-account.mjs";
import { createCodexSubscription } from "./codex-subscription.mjs";

export function createOpenCodeAdapter({
  backend,
  config,
  providers,
  send,
  broadcast,
  createHost,
  readCodexAccount,
}) {
  const storage = createStorage(join(backend.stateDir, "index.json"), {
    sessions: {},
  });
  const active = new Map();
  const mutating = new Set();
  const operations = new Map();
  const queued = new Map();
  const compactions = createCompactions(broadcast);
  const workspace = createWorkspace({ broadcast, configDir: config.configDir });
  let host,
    ready = false,
    error = null,
    closed = false,
    stream,
    streamAbort;
  const notify = (method, params, id) =>
    broadcast({ method, params, ...(id !== undefined && { id }) });
  const sdk = () => host;
  const subscription = createCodexSubscription(
    createCodexAccountSource({
      codexHome: config.codexHome,
      read: readCodexAccount,
    }),
  );
  const sessions = createOpenCodeSessions({
    sdk,
    storage,
    active,
    notify,
    config,
  });
  const catalogue = createOpenCodeCatalogue({
    sdk,
    backend,
    providers,
    active,
    subscription,
  });
  const questions = createOpenCodeQuestions({
    sdk,
    sessions,
    active,
    notify,
    publish,
  });
  const tasks = createOpenCodeTasks({ sdk, sessions, notify });
  const goals = createOpenCodeGoals({ sdk, sessions, notify, active });
  const account = createOpenCodeAccount({ providers, subscription });
  const events = createOpenCodeEvents({
    sdk,
    sessions,
    active,
    compactions,
    questions,
    notify,
    publish,
    settled: goals.settled,
    usage: goals.usage,
  });
  const methods = createProductMethods({
    config,
    projectModelsDirectory: backend.stateDir,
    call: dispatch,
    activeTurns: active,
    activeThreads: active,
    checkCompaction: (id) => compactions.entries.get(id),
    readAgentMessages: async (id) => ({
      messages: (await sessions.turns(id)).flatMap((t) =>
        t.items.filter((i) => i.type === "userMessage"),
      ),
    }),
    broadcast,
  });
  function state() {
    return {
      method: "lan/state",
      params: {
        ready,
        error,
        activeTurns: Object.fromEntries(active),
        questions: [...questions.entries.values()].map((q) => q.question),
        compactions: Object.fromEntries(compactions.entries),
        terminals: {},
        backgroundTasks: tasks.snapshot(),
        queuedInputs: Object.fromEntries(queued),
        undoneFiles: [...methods.files.undoneFiles.values()],
      },
    };
  }
  function publish() {
    if (!closed) broadcast(state());
  }
  async function submit(p) {
    const threadId = p.threadId;
    if (mutating.has(threadId))
      throw new Error("对话历史正在更新，请稍后重试。");
    const sessionID = await sessions.nativeId(threadId);
    const existed = active.has(threadId);
    if (!existed) await catalogue.sync();
    if (!existed) await subscription.sync();
    const turnId =
      active.get(threadId) || `msg_${randomUUID().replaceAll("-", "")}`;
    const id = existed ? `msg_${randomUUID().replaceAll("-", "")}` : turnId;
    if (!existed) {
      if (p.model)
        await host.sessions.switchModel({
          sessionID,
          model: modelRef(
            p.model,
            p.effort || p.reasoningEffort,
            p.serviceTier,
          ),
        });
      const plan = p.collaborationMode?.mode === "plan";
      const native = await host.sessions.get({ sessionID });
      const saved = await sessions.record(threadId);
      if (plan && native.agent !== "plan")
        await sessions.update(threadId, { executionAgent: native.agent });
      if (plan || native.agent === "plan") {
        const agents = await host.agent.list({ location: native.location });
        await host.sessions.switchAgent({
          sessionID,
          agent: plan
            ? "plan"
            : saved.executionAgent ||
              agents.data.find(
                (a) => a.id !== "plan" && a.mode !== "subagent" && !a.hidden,
              )?.id ||
              "build",
        });
      }
      events.plans.set(threadId, plan);
    }
    active.set(threadId, turnId);
    const text = (p.input || [])
      .filter((i) => i.type === "text")
      .map((i) => i.text)
      .join("\n");
    const files = (p.input || [])
      .filter((i) => ["image", "localImage"].includes(i.type))
      .map((i) => ({ uri: i.url || pathToFileURL(i.path).href }));
    try {
      const command = /^\s*\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text);
      if (command) {
        const native = await host.sessions.get({ sessionID });
        const commands = await host.command.list({ location: native.location });
        if (commands.data.some((c) => c.name === command[1])) {
          await host.sessions.command({
            sessionID,
            name: command[1],
            text: command[2] || "",
            files,
            delivery: "steer",
          });
          const turn = (await sessions.turns(threadId)).at(-1);
          if (turn) {
            active.set(threadId, turn.id);
            publish();
            return { turn };
          }
          active.delete(threadId);
          publish();
          return { turn: { id: turnId, status: "completed", items: [] } };
        }
      }
      const inbox = await host.sessions.prompt({
        sessionID,
        id,
        text,
        files,
        skills: (p.input || [])
          .filter((i) => i.type === "skill")
          .map((i) => ({ id: i.name })),
        delivery: "steer",
        metadata: { claudexTurnId: turnId },
      });
      notify("lan/inputQueue/updated", { threadId });
      publish();
      return existed
        ? { turnId, inputId: inbox.id }
        : { turn: { id: turnId, status: "inProgress", items: [] } };
    } catch (e) {
      if (!existed) active.delete(threadId);
      publish();
      throw e;
    }
  }
  async function dispatch(method, p) {
    if (methods.offline.has(method)) return methods.offline.get(method)(p);
    if (!ready) throw new Error(error || "OpenCode 尚未就绪");
    if (methods.online.has(method)) return methods.online.get(method)(p);
    assertConversationOperation(method, {
      compacting: compactions.busy(p.threadId),
      undoing: methods.files.undoing.has(p.threadId),
      active: active.has(p.threadId),
    });
    if (sessions.handles(method)) {
      if (
        [
          "thread/revert",
          "thread/rollback",
          "thread/delete",
          "thread/fork",
        ].includes(method)
      ) {
        if (active.has(p.threadId) || mutating.has(p.threadId))
          throw new Error("请等待当前任务结束后修改历史。");
        mutating.add(p.threadId);
        try {
          return await sessions.request(method, p);
        } finally {
          mutating.delete(p.threadId);
        }
      }
      return sessions.request(method, p);
    }
    if (["turn/start", "turn/steer"].includes(method)) return submit(p);
    const sessionID = p.threadId && (await sessions.nativeId(p.threadId));
    if (method === "turn/interrupt") {
      await host.sessions.interrupt({ sessionID, resume: false });
      return {};
    }
    if (method === "thread/compact/start") {
      const id = randomUUID();
      compactions.start(p.threadId, id);
      try {
        await host.sessions.compact({ sessionID });
        return {};
      } catch (e) {
        compactions.reject(p.threadId, id, e.message);
        throw e;
      }
    }
    if (method === "lan/inputQueue/list")
      return {
        entries: (await host.sessions.inbox.list({ sessionID }))
          .filter((i) => i.type === "user")
          .map((i) => ({
            id: i.id,
            status: "queued",
            input: [{ type: "text", text: i.payload.text }],
            createdAt: i.time.created / 1000,
          })),
      };
    if (method === "lan/inputQueue/cancel") {
      await host.sessions.inbox.cancel({ sessionID, inboxID: p.id });
      return {};
    }
    if (method === "lan/inputQueue/retry") {
      await host.sessions.inbox.update({
        sessionID,
        inboxID: p.id,
        delivery: "steer",
      });
      return {};
    }
    if (method === "review/start")
      return submit({
        ...p,
        input: [
          {
            type: "text",
            text: "审查当前项目所有未提交的变更，检查正确性、回归和测试缺口。按严重程度列出可核查的问题与文件位置。保持项目文件不变。",
          },
        ],
        collaborationMode: { mode: "plan" },
      });
    const context = p.threadId ? await sessions.read(p.threadId) : p;
    if (
      workspace.handles(method, backend, "bridge") ||
      method === "fuzzyFileSearch"
    )
      return workspace.request(method, {
        ...p,
        cwd: context.cwd || config.defaultCwd,
      });
    if (method === "fs/readFile") {
      const bytes = await host.file.read({
        path: p.path,
        location: { directory: context.cwd || config.defaultCwd },
      });
      return { dataBase64: Buffer.from(bytes).toString("base64") };
    }
    for (const service of [goals, tasks, account]) {
      const result = await service.request(method, {
        ...p,
        model: p.model || context.model,
        cwd: context.cwd || config.defaultCwd,
      });
      if (result !== undefined) return result;
    }
    const result = await catalogue.request(method, {
      ...p,
      cwd: context.cwd || config.defaultCwd,
    });
    if (result !== undefined) return result;
    throw new Error(`OpenCode 操作尚未实现：${method}`);
  }
  async function connect() {
    try {
      await catalogue.sync();
      await subscription.sync();
      const create =
        createHost ||
        (
          await loadOpenCode(
            backend.sdkEntry || (await resolveOpenCode(config.configDir)).entry,
          )
        ).create;
      host = await create({
        database: { path: process.env.OPENCODE_DB || "opencode.db" },
        config: { file: catalogue.file },
        events: { persist: true },
        plugins: [goals.plugin, catalogue.plugin, subscription.plugin],
      });
      streamAbort = new AbortController();
      stream = (async () => {
        for await (const e of host.events.subscribe({
          signal: streamAbort.signal,
        })) {
          if (closed) break;
          const sessionID = e.data?.sessionID;
          if (e.type === "session.deleted") sessions.removed.add(sessionID);
          if (sessions.removed.has(sessionID)) continue;
          try {
            await events.event(e);
            if (e.type.startsWith("session.inbox.")) {
              const entries = await host.sessions.inbox.list({
                sessionID: e.data.sessionID,
              });
              const id = await sessions.logicalId(e.data.sessionID);
              if (entries.length) queued.set(id, entries.length);
              else queued.delete(id);
              publish();
            }
          } catch (eventError) {
            // Deletion owns late events, including reads already in flight.
            if (!sessions.removed.has(sessionID)) throw eventError;
          }
          if (
            /^(shell|session.execution|session.tool)\./.test(e.type) &&
            !e.type.endsWith("delta")
          ) {
            await tasks.refresh();
            publish();
          }
        }
      })().catch((e) => {
        if (!closed) {
          error = e.message;
          ready = false;
          publish();
        }
      });
      const running = await host.sessions.active();
      for (const id of Object.keys(running)) {
        const logical = await sessions.logicalId(id);
        active.set(logical, id);
        await events.refresh(logical);
        const inputs = await host.sessions.inbox.list({ sessionID: id });
        if (inputs.length) queued.set(logical, inputs.length);
      }
      await questions.recover(Object.keys(running));
      await tasks.refresh();
      ready = true;
      publish();
    } catch (e) {
      error = e.message;
      publish();
      throw e;
    }
  }
  async function request(message) {
    const id = message.params?.threadId;
    if (!id) return dispatch(message.method, message.params || {});
    const operation = (operations.get(id) || Promise.resolve())
      .catch(() => {})
      .then(() => dispatch(message.method, message.params || {}));
    operations.set(id, operation);
    try {
      return await operation;
    } finally {
      if (operations.get(id) === operation) operations.delete(id);
    }
  }
  return {
    capabilities: opencodeCapabilities,
    workspaceOwner: "bridge",
    state,
    connect,
    get ready() {
      return ready;
    },
    releaseClient() {},
    releaseUnusedThreads() {
      if (ready)
        tasks
          .refresh()
          .then(publish)
          .catch((e) => {
            error = e.message;
            publish();
          });
    },
    async receive(client, message) {
      try {
        if (!message.method) return await questions.answer(message);
        send(client, {
          id: message.id,
          result: await request(message),
        });
      } catch (e) {
        if (message.method)
          send(client, {
            id: message.id,
            error: { code: -32000, message: e.message },
          });
      }
    },
    async close() {
      closed = true;
      ready = false;
      sessions.close();
      streamAbort?.abort();
      subscription.close();
      await host?.close();
      await stream;
      sessions.removed.clear();
      workspace.close();
    },
  };
}
