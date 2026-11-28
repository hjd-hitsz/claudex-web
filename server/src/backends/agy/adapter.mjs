import { readPromptSections, renderPrompt } from "../../prompts.mjs";
import { resourceTarget } from "../../../../shared/backend-identity.mjs";
import { createAgyQuota } from "./quota.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { agyPromptBlocks } from "./acp-prompt.mjs";
import { projectSkills } from "./tmp_function/project-skills.mjs";
import { visibleAgyItems } from "./acp-messages.mjs";
import { createAgyHistoryActions } from "./tmp_function/session-history.mjs";
import {
  createAgyNativeHistoryActions,
  hasAgyHistoryAction,
} from "./tmp_function/native-history-actions.mjs";
import { agyBackgroundMethods } from "./tmp_function/background-tasks.mjs";
import { agyPluginMethods } from "./tmp_function/plugin-status.mjs";
import { createAcpSessions } from "./acp-session.mjs";
import { countAgyCompactions } from "./context-usage.mjs";
import { createDelegations } from "./delegations.mjs";
import {
  currentResultNotice,
  executing,
} from "../delegation/delegation-store.mjs";
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

function assertDelegatesIdle(data, threadId) {
  if (
    Object.values(data.tasks).some(
      ({ parentId, status }) => parentId === threadId && executing.has(status),
    )
  )
    throw new Error("请先等待或停止此对话的委派任务");
}

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
  const background = agyBackgroundMethods({ config, store });
  const plugins = agyPluginMethods({
    getBackend,
    defaultCwd: config.defaultCwd,
    entries: sessions.entries,
  });
  const active = sessions.busy;
  const thread = (s) => agyThread(s, active(s.id));
  const notify = (method, params) => emit({ method, params });
  const history = createHistoryPages(
    async (id) => {
      const turns = await readTurns(id);
      return { turns, compactCount: countAgyCompactions(turns) };
    },
    (items, params) => agyPage(items, params, params.sortDirection !== "asc"),
  );
  const { files, offline, online } = createProductMethods({
    config,
    projectModelsDirectory: join(backend.stateDir, "model-settings"),
    checkCompaction: async (id) =>
      sessions.compactions.get(id) ||
      (await readSession(id)).turns.findLast((turn) => turn.compaction)
        ?.compaction,
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
  const occupancy = (id) => ({
    active: sessions.active.has(id),
    pending:
      sessions.pending.has(id) &&
      sessions.pending.get(id) !== sessions.active.get(id)?.turn.id,
    compacting: sessions.compactions.get(id)?.status === "running",
    undoing: files.undoing.has(id),
    delivering: execution.delivering(id),
  });
  const nativeHistory = createAgyNativeHistoryActions({
    store,
    sessions,
    occupancy,
    readExecutorBackground: execution.readExecutorBackground,
    changed(event, threadId, threadName) {
      notify(event, {
        threadId,
        ...(threadName !== undefined && { threadName }),
      });
      if (event === "thread/unarchived") execution.wake();
    },
  });
  const rewriteHistory = createAgyHistoryActions({
    store,
    rewriting: sessions.rewriting,
    occupancy,
    prepare: sessions.prepareHistory,
    toolResults: sessions.toolResults,
    discard: sessions.discard,
    wake: execution.wake,
    changed(s, fork) {
      if (fork) {
        notify("thread/started", { thread: thread(s) });
        return;
      }
      history.invalidate(s.id);
      sessions.compactions.delete(s.id);
      notify("thread/tokenUsage/updated", { threadId: s.id, tokenUsage: null });
      notify("thread/reverted", { threadId: s.id, resetContext: true });
    },
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
    return allTurns.map((turn, index) => ({
      ...turn,
      turnNumber: index + 1,
      items: [
        ...visibleAgyItems(turn.items),
        ...tasks
          .filter(({ parentTurnId }) => parentTurnId === turn.id)
          .map(execution.project),
      ],
    }));
  }
  async function create(params) {
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
      name: "",
      turns: [],
      threadSource: params.threadSource,
      model: params.model || "",
      effort: "",
    };
    await store.change((data) => {
      data.sessions[id] = s;
    });
    notify("thread/started", { thread: thread(s) });
    return threadSettings(s);
  }

  function threadSettings(s) {
    const liveUsage = sessions.active.get(s.id)?.liveTokenUsage;
    return {
      thread: { ...thread(s), ...(liveUsage && { tokenUsage: liveUsage }) },
      cwd: s.cwd,
      model: s.model,
      reasoningEffort: s.effort,
      collaborationMode: { mode: "default" },
    };
  }

  async function start(session, p, method) {
    const input = p.input || [];
    const inputs = await agyPromptBlocks(input, {
      cwd: session.cwd,
      configDir: config.configDir,
      capabilities: sessions.promptCapabilities(),
    });
    const s = await readSession(session.id);
    if (s.archived) throw new Error("请恢复归档后再发送");
    if (sessions.rewriting.has(s.id))
      throw new Error("正在更新 agy 对话历史，请稍后重试");
    if (sessions.compactions.get(s.id)?.status === "running")
      throw new Error("正在整理上下文，完成后可继续发送");
    assertConversationOperation(method, {
      undoing: files.undoing.has(s.id),
      active: active(s.id),
    });
    if (p.collaborationMode?.mode === "plan")
      throw new Error("agy 使用秘书模式");
    if (p.delegateTo && !backend.delegates[p.delegateTo]?.enabled)
      throw new Error("所选委派执行端已停用");
    if (
      "expectedLastTurnId" in p &&
      (active(s.id) || (s.turns.at(-1)?.id ?? null) !== p.expectedLastTurnId)
    )
      throw new Error("对话已有新消息或输入正在发送，请重新打开对话后编辑");
    const options = {
      model: p.model,
      effort: p.effort,
      delegateTo: p.delegateTo,
      userInput: true,
      nativeCommand: p.nativeCommand,
    };
    if (options.nativeCommand) {
      const command =
        inputs[0]?.type === "text" ? inputs[0].text.trimStart() : "";
      if (
        /^\/([\w:-]+)(?=\s|$)/.exec(command)?.[1].toLowerCase() !==
        options.nativeCommand
      )
        throw new Error("Antigravity 命令与当前输入不匹配，请重新选择");
      if (method === "turn/steer")
        throw new Error("请等待本轮结束后再执行 Antigravity 原生命令");
      inputs[0].text = command;
    }
    const item = { id: randomUUID(), type: "userMessage", content: input };
    if (!inputs.length) throw new Error("请填写消息");
    if (p.delegateTo)
      inputs.push({
        type: "text",
        text: renderPrompt(workflow("secretarySelection"), {
          target: p.delegateTo,
        }),
      });
    if (method === "turn/steer")
      return sessions.steer(s, p.expectedTurnId, item, options, inputs);
    const id = randomUUID();
    sessions
      .replace(s, { id, items: [item] }, options, inputs)
      .catch((e) =>
        notify("error", { threadId: s.id, error: { message: e.message } }),
      )
      .finally(execution.wake);
    return { turn: { id, status: "inProgress", items: [] } };
  }

  async function skills(p) {
    const session = p.threadId ? await readSession(p.threadId) : null;
    const cwd = session?.cwd || p.cwd || config.defaultCwd;
    const directories = session ? [cwd] : p.cwds || [cwd];
    const data = await Promise.all(
      directories.map(async (directory) => ({
        cwd: directory,
        skills: (await projectSkills(await realpath(directory))).map(
          ({ text, ...skill }) => skill,
        ),
      })),
    );
    const commands = await sessions.commands(session?.id);
    return { data, commands };
  }

  async function request(method, p) {
    if (isDelegationThread(p.threadId)) {
      if (agyHistoryMethods.has(method) || method === "lan/agents/messages")
        return execution.history(method, p);
      throw new Error("委派对话只支持读取历史");
    }
    const handler = offline.get(method) || online.get(method);
    if (handler) return handler(p);
    if (background.has(method)) return background.get(method)(p);
    if (plugins.has(method)) return plugins.get(method)(p);
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
    if (method === "skills/list") return skills(p);
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
    if (method === "thread/fork" || method === "thread/revert") {
      const updated = await rewriteHistory(method, p.threadId, p);
      return threadSettings(updated);
    }
    const data = await store.read();
    const s = store.session(data, p.threadId);
    if (sessions.rewriting.has(s.id))
      throw new Error("正在更新 agy 对话历史，请稍后重试");
    if (method === "thread/resume") {
      if (s.archived) throw new Error("请恢复归档后再发送");
      if (s.nativeId && !active(s.id)) await sessions.open(s);
      return threadSettings(await readSession(s.id));
    }
    if (hasAgyHistoryAction(method))
      return nativeHistory.apply(method, s, p, data);
    if (method === "turn/start" || method === "turn/steer")
      return start(s, p, method);
    if (method === "thread/compact/start") {
      assertConversationOperation(method, {
        undoing: files.undoing.has(s.id),
        active: active(s.id),
      });
      if (s.archived) throw new Error("请恢复归档后再整理上下文");
      if (!s.nativeId) throw new Error("请先完成一轮对话再整理上下文");
      assertDelegatesIdle(data, s.id);
      if (
        Object.values(data.notices).some(
          (notice) =>
            notice.parentId === s.id &&
            ["queued", "submitting"].includes(notice.status) &&
            currentResultNotice(data, notice),
        )
      )
        throw new Error("请等待此对话的委派结果回投完成");
      const { compaction, completion } = sessions.compact(s);
      completion.finally(execution.wake);
      return { compaction };
    }
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
        await nativeHistory.recover();
        await store.change((data) => {
          for (const session of Object.values(data.sessions))
            for (const turn of session.turns) {
              if (turn.status !== "inProgress") continue;
              turn.status = "interrupted";
              if (turn.compaction?.status === "running") {
                turn.compaction.status = "interrupted";
                turn.compaction.completedAt = nowSeconds();
              }
            }
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
          queuedInputs: Object.fromEntries(
            [...sessions.pending].filter(
              ([id, turnId]) => sessions.active.get(id)?.turn.id !== turnId,
            ),
          ),
          compactions: Object.fromEntries(sessions.compactions),
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
