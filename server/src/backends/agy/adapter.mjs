import { readPromptSections, renderPrompt } from "../../prompts.mjs";
import { resourceTarget } from "../../../../shared/backend-identity.mjs";
import { createAgyQuota } from "./quota.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { acpContent } from "./acp-events.mjs";
import { agyConversationContext, visibleAgyItems } from "./acp-messages.mjs";
import { createAcpSessions } from "./acp-session.mjs";
import { createDelegations } from "./delegations.mjs";
import { executing } from "../delegation/delegation-store.mjs";
import {
  agyHistoryMethods,
  isDelegationThread,
} from "../delegation/delegation-history.mjs";
import {
  createAgyStore,
  agyPage,
  agyThread,
  nowSeconds,
} from "./session-store.mjs";
import { createHistoryPages } from "../history-pages.mjs";
import { createProductMethods } from "../../bridge/product-methods.mjs";
import { assertConversationOperation } from "../../bridge/conversation-policy.mjs";

const workflow = readPromptSections("delegation/workflow.md");

export function createAgyAdapter({
  backend: initialBackend,
  config,
  version,
  socket,
  emit,
}) {
  let backend = initialBackend;
  let ready = false;
  let error = "";
  const store = createAgyStore(backend.stateDir);
  const getBackend = () => backend;
  const quota = createAgyQuota(getBackend);
  const execution = createDelegations({
    store,
    getBackend,
    config,
    version,
    emit,
    sessions: () => sessions,
  });
  const sessions = createAcpSessions({
    store,
    getBackend,
    socket,
    execution,
    emit,
  });
  const compactions = new Map();
  const active = sessions.busy;
  const thread = (s) => agyThread(s, active(s.id));
  const notify = (method, params) => emit({ method, params });
  const history = createHistoryPages(readTurns, (items, params) =>
    agyPage(items, params, params.sortDirection !== "asc"),
  );
  const { files, offline, online } = createProductMethods({
    config,
    projectModelsDirectory: join(backend.stateDir, "model-settings"),
    checkCompaction: (id) => compactions.get(id),
    readAgentMessages: () => ({ messages: [] }),
    call: async (_method, { threadId }) => ({
      thread: {
        ...thread(await readSession(threadId)),
        turns: await readTurns(threadId),
      },
    }),
    activeTurns: { has: active },
    activeThreads: { has: active },
    broadcast: emit,
  });

  async function readSession(id) {
    return store.session(await store.read(), id);
  }
  async function readTurns(id) {
    const state = await store.read();
    const s = store.session(state, id);
    const recent = sessions.active.get(id)?.turn;
    const allTurns = recent
      ? [...s.turns.filter(({ id }) => id !== recent.id), recent]
      : s.turns;
    const tasks = Object.values(state.tasks).filter(
      ({ parentId }) => parentId === id,
    );
    return allTurns.map((turn) => ({
      ...turn,
      items: [
        ...visibleAgyItems(turn.items),
        ...tasks
          .filter(({ parentTurnId }) => parentTurnId === turn.id)
          .map(execution.project),
      ],
    }));
  }
  async function create(params, source) {
    const id = randomUUID();
    const cwd = params.projectless
      ? join(config.projectlessRoot, id)
      : params.cwd || config.defaultCwd;
    if (params.projectless) await mkdir(cwd, { recursive: true, mode: 0o700 });
    const time = nowSeconds();
    const s = {
      id,
      cwd: await realpath(cwd),
      createdAt: time,
      updatedAt: time,
      name: source ? "从历史继续" : "",
      turns: [],
      threadSource: params.threadSource,
      model: params.model || "",
      effort: "",
      ...(source && { source }),
    };
    await store.change((data) => {
      data.sessions[id] = s;
    });
    notify("thread/started", { thread: thread(s) });
    return threadSettings(s);
  }

  function threadSettings(s) {
    return {
      thread: thread(s),
      cwd: s.cwd,
      model: s.model,
      reasoningEffort: s.effort,
      collaborationMode: { mode: "default" },
    };
  }

  function start(s, p, compact = false) {
    if (s.archived) throw new Error("请恢复归档后再发送");
    assertConversationOperation(
      compact ? "thread/compact/start" : "turn/start",
      { undoing: files.undoing.has(s.id), active: active(s.id) },
    );
    if (p.collaborationMode?.mode === "plan")
      throw new Error("agy 使用秘书模式");
    if (p.delegateTo && !backend.delegates[p.delegateTo]?.enabled)
      throw new Error("所选委派执行端已停用");
    const id = randomUUID();
    const input = p.input || [];
    const options = {
      model: p.model,
      effort: p.effort,
      delegateTo: p.delegateTo,
      userInput: !compact,
    };
    const items = compact
      ? []
      : [{ id: randomUUID(), type: "userMessage", content: input }];
    const inputs = compact
      ? [{ type: "text", text: "/compact" }]
      : acpContent(input);
    if (!compact && !inputs.length) throw new Error("请填写消息");
    if (!compact && p.delegateTo)
      inputs.push({
        type: "text",
        text: renderPrompt(workflow("secretarySelection"), {
          target: p.delegateTo,
        }),
      });
    if (!compact && s.source?.context && !s.turns.length)
      inputs.unshift({
        type: "text",
        text: renderPrompt(workflow("secretaryContinuation"), {
          history: s.source.context,
        }),
      });
    if (compact) {
      compactions.set(s.id, {
        id,
        turnId: id,
        status: "running",
        startedAt: nowSeconds(),
      });
      notify("lan/compaction", {
        threadId: s.id,
        compaction: compactions.get(s.id),
      });
    }
    const prompt = compact ? sessions.prompt : sessions.replace;
    prompt(s, { id, items }, options, inputs)
      .then(({ turn, compacted }) => {
        if (!compact) return;
        const entry = {
          ...compactions.get(s.id),
          status:
            turn.status === "completed"
              ? compacted
                ? "completed"
                : "unconfirmed"
              : turn.status,
          completedAt: nowSeconds(),
          error: turn.error?.message,
          commandFinished: turn.status === "completed",
        };
        compactions.set(s.id, entry);
        notify("lan/compaction", { threadId: s.id, compaction: entry });
      })
      .catch((e) =>
        notify("error", { threadId: s.id, error: { message: e.message } }),
      )
      .finally(execution.wake);
    return compact
      ? { compaction: compactions.get(s.id) }
      : { turn: { id, status: "inProgress", items: [] } };
  }

  async function historyAction(method, s, p) {
    if (active(s.id)) throw new Error("请先等待 agy 轮次结束");
    const data = await store.read();
    const tasks = Object.values(data.tasks).filter(
      ({ parentId }) => parentId === s.id,
    );
    if (
      tasks.some(({ status }) => executing.has(status)) &&
      method !== "thread/name/set"
    )
      throw new Error("请先等待或停止此对话的委派任务");
    if (method === "thread/fork") {
      const turnId = p.lastTurnId || p.turnId || p.fromTurnId;
      const index = turnId
        ? s.turns.findIndex(({ id }) => id === turnId)
        : s.turns.length - 1;
      if (turnId && index < 0) throw new Error("找不到要继续的轮次");
      const context = agyConversationContext(s.turns.slice(0, index + 1));
      return create(
        {
          cwd: s.cwd,
          model: p.model || s.model,
          threadSource: p.threadSource || s.threadSource,
        },
        { threadId: s.id, turnId, context },
      );
    }
    const events = {
      "thread/name/set": ["name", (p.name || "").trim(), "thread/name/updated"],
      "thread/archive": ["archived", true, "thread/archived"],
      "thread/unarchive": ["archived", false, "thread/unarchived"],
      "thread/delete": ["deleted", true, "thread/deleted"],
    };
    const [field, value, event] = events[method];
    await store.change((data) => {
      store.session(data, s.id)[field] = value;
    });
    if (field !== "name") sessions.discard(s.id);
    notify(event, {
      threadId: s.id,
      ...(field === "name" && { threadName: value }),
    });
    if (method === "thread/unarchive") execution.wake();
    return {};
  }

  async function request(method, p) {
    if (isDelegationThread(p.threadId)) {
      if (agyHistoryMethods.has(method) || method === "lan/agents/messages")
        return execution.history(method, p);
      throw new Error("委派对话只支持读取历史");
    }
    const handler = offline.get(method) || online.get(method);
    if (handler) return handler(p);
    if (method === "model/list")
      return { data: (await sessions.catalogue()).models };
    if (method === "config/read") {
      const { model, effort } = await sessions.catalogue();
      return { config: { model, model_reasoning_effort: effort } };
    }
    if (method === "account/read")
      return { account: { type: "agy", usageSupported: true } };
    if (method === "account/rateLimits/read") {
      if (!ready) throw new Error(error || "agy ACP 尚未就绪");
      return quota.read();
    }
    if (method === "skills/list") return { data: [] };
    if (method === "thread/list") {
      const { sessions } = await store.read();
      const query = (p.searchTerm || "").toLowerCase();
      return agyPage(
        Object.values(sessions)
          .filter(
            (s) =>
              !s.deleted &&
              Boolean(s.archived) === Boolean(p.archived) &&
              (!query ||
                [s.name, s.cwd].some((field) =>
                  field.toLowerCase().includes(query),
                )),
          )
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .map(thread),
        p,
      );
    }
    if (method === "thread/read") {
      const s = await readSession(p.threadId);
      const result = threadSettings(s);
      if (p.includeTurns) result.thread.turns = await readTurns(s.id);
      return result;
    }
    if (agyHistoryMethods.has(method)) return history.read(method, p);
    if (!ready) throw new Error(error || "agy ACP 尚未就绪");
    if (method === "thread/start") return create(p);
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    const s = await readSession(p.threadId);
    if (method === "thread/resume") {
      if (s.archived) throw new Error("请恢复归档后再发送");
      if (s.nativeId && !active(s.id)) await sessions.open(s);
      return threadSettings(await readSession(s.id));
    }
    if (
      [
        "thread/name/set",
        "thread/archive",
        "thread/unarchive",
        "thread/delete",
        "thread/fork",
      ].includes(method)
    )
      return historyAction(method, s, p);
    if (method === "turn/start" || method === "turn/steer") return start(s, p);
    if (method === "thread/compact/start") return start(s, p, true);
    if (method === "turn/interrupt") {
      sessions.interrupt(s.id);
      return {};
    }
    if (method === "lan/agy/respond") {
      const target = resourceTarget(p.requestId, "agy");
      if (target.backendId !== "agy") throw new Error("审批请求后端不匹配");
      return execution.respond({ ...p, id: target.nativeId });
    }
    if (method === "lan/agy/delegation/cancel")
      return execution.cancel(s.id, p.taskId);
    throw new Error("agy 不支持此操作：" + method);
  }

  return {
    request,
    execution,
    async connect() {
      try {
        await sessions.connect(backend.executable);
        await store.change((data) => {
          for (const session of Object.values(data.sessions))
            for (const turn of session.turns)
              if (turn.status === "inProgress") turn.status = "interrupted";
        });
        ready = true;
        execution.wake();
      } catch (e) {
        error = e.message;
      }
    },
    configure(value) {
      backend = value;
      execution.wake();
    },
    async state() {
      const { questions, pending } = await execution.snapshot();
      return {
        method: "lan/state",
        params: {
          ready,
          error,
          questions,
          delegationTasks: pending,
          activeTurns: Object.fromEntries(
            [...sessions.active].map(([id, { turn }]) => [id, turn.id]),
          ),
          compactions: Object.fromEntries(compactions),
          undoneFiles: [...files.undoneFiles.values()],
        },
      };
    },
    close() {
      quota.close();
      history.close();
      execution.close();
      sessions.close();
    },
  };
}
