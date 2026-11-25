import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ActiveExecution,
  ExecutionTurn,
  QueuedInput,
  RuntimeDependencies,
  TurnRequest,
  SessionDependencies,
} from "./execution-types.d.mts";
import { automaticTurn, completeTurn } from "./native-turn.mjs";
import { interruptQueuedInput } from "./native-control.mjs";
import { convertMessage } from "./messages.mjs";
import { inputMessage, userPrompt } from "./prompt.mjs";
import { createExecutionSession } from "./execution-session.mjs";
import { nativeSubagentProvider } from "./native-provider.mjs";
import { createBackgroundTasks } from "./background-tasks.mjs";
import { createGoals } from "./goals.mjs";
import { modelOptions } from "./model-options.mjs";
import { recoverClaudeSessions } from "./recovery.mjs";
import { assertConversationOperation } from "../../bridge/conversation-policy.mjs";
import { subagentSettings } from "../../../../shared/subagent-settings.mjs";
import type { ConversationInput } from "./conversation-protocol.d.mts";
import {
  assertPeerQueue,
  peerInputState,
  queuedInput,
  recordPeerRejection,
} from "./conversation-input.mjs";
import { createPeerSteer, createSteer } from "./steer.mjs";

type Run = Awaited<ReturnType<typeof createExecutionSession>> & {
  nativeSessionId: string;
  effort: QueuedInput["effort"];
  serviceTier: QueuedInput["serviceTier"];
  review: QueuedInput["review"];
};

export function createClaudeRuntime({
  backend,
  storage,
  providers,
  broadcast,
  compactions,
  questions,
  observeMessage,
  callConversationTool,
  readSubagentSettings = async () => subagentSettings(backend),
}: RuntimeDependencies) {
  const running = new Map<string, ActiveExecution>();
  const queries = new Map<string, Run>();
  const mutating = new Set<string>();
  const starting = new Map<string, Promise<void>>();
  const idleWaiters = new Map<string, Set<() => void>>();
  let closed = false;
  const emit: SessionDependencies["emit"] = (method, params) =>
    broadcast({ method, params });
  const save: SessionDependencies["save"] = async (id, change) => {
    await storage.update((data) => ({
      ...data,
      sessions: { ...data.sessions, [id]: change(data.sessions[id]) },
    }));
  };
  const tasks = createBackgroundTasks({ storage, save, emit });
  const goals = createGoals({
    storage,
    save,
    emit,
    start: enqueue,
    interrupt,
    running,
    backend,
    queries,
    command,
  });
  async function enqueue(
    threadId: string,
    params: TurnRequest,
    compact = false,
    peer?: ConversationInput,
  ) {
    if (closed) throw new Error("后端已关闭");
    if (!peer && mutating.has(threadId))
      throw new Error("正在修改对话历史，请稍后发送");
    const input = compact ? [{ type: "text", text: "/compact" }] : params.input;
    inputMessage(input);
    const turn = queuedInput(params, input, compact, peer);
    await save(threadId, (session) => {
      if (peer) assertPeerQueue(session, turn.id, occupied(threadId));
      if (peer && session.peerInputs?.[turn.id]) return session;
      if (!session) throw new Error("对话不存在");
      assertConversationOperation(
        compact ? "thread/compact/start" : "turn/start",
        {
          compacting: compactions.busy(threadId),
          active: running.has(threadId),
          pending: session.queue?.length,
        },
      );
      return {
        ...session,
        ...peerInputState(session, turn),
        ...(params.cwd &&
          params.cwd !== session.cwd && {
            cwd: params.cwd,
            historySearchAll: true,
          }),
        queue: [...(session.queue || []), turn],
      };
    });
    if (compact) compactions.start(threadId, turn.id);
    emit("lan/inputQueue/updated", { threadId });
    schedule(threadId);
    return { turn: { id: turn.id, status: "queued", items: [] } };
  }
  const occupied = (id: string) =>
    running.has(id) ||
    starting.has(id) ||
    mutating.has(id) ||
    compactions.busy(id);
  async function settle(
    threadId: string,
    result?: SDKResultMessage | null,
    error?: unknown,
  ) {
    const active = running.get(threadId);
    if (!active) return;
    const turn = completeTurn(active, result, error);
    await save(threadId, (s) => ({
      ...s,
      active: null,
      updatedAt: turn.completedAt,
      turns: { ...s.turns, [turn.id]: turn },
      ...(active.queued.compact && {
        compaction: {
          ...s.compaction,
          turnId: turn.id,
          status: turn.status,
          completedAt: turn.completedAt,
          error: turn.error?.message,
        },
      }),
    }));
    await goals.settled(threadId, active, turn);
    for (const [id, q] of questions)
      if (q.threadId === threadId) {
        q.resolve({ behavior: "deny", message: "任务已结束" });
        questions.delete(id);
      }
    running.delete(threadId);
    goals
      .afterSettled(threadId)
      .catch((error) =>
        emit("error", { threadId, error: { message: error.message } }),
      );
    for (const resolve of idleWaiters.get(threadId) || []) resolve();
    idleWaiters.delete(threadId);
    compactions.event("turn/completed", { threadId, turn });
    emit("turn/completed", { threadId, turn });
    schedule(threadId);
  }
  async function drain(threadId: string) {
    if (running.has(threadId) || closed || mutating.has(threadId)) return;
    const session = (await storage.read()).sessions[threadId];
    if (running.has(threadId) || mutating.has(threadId)) return;
    const queued = session?.queue?.[0];
    if (!queued || queued.status === "uncertain") return;
    if (queued.peer && (session.deleted || session.archived)) {
      await recordPeerRejection(threadId, queued.id, save, "目标会话已关闭。");
      return;
    }
    const turn: ExecutionTurn = {
      id: queued.id,
      status: "inProgress",
      startedAt: Date.now() / 1000,
      items: [],
      mode: queued.mode,
    };
    const active: ActiveExecution = {
      query: null,
      interrupted: false,
      turn,
      queued,
      goalId: queued.goalId,
      inputIds: new Set([queued.id]),
    };
    running.set(threadId, active);
    let submitted = false;
    try {
      await save(threadId, (s) => ({
        ...s,
        queue: s.queue?.slice(1),
        active: queued,
        turns: { ...s.turns, [turn.id]: turn },
        updatedAt: turn.startedAt,
        model: queued.model || s.model,
        providerId: queued.providerId ?? s.providerId,
        mode: queued.mode,
        review: queued.review,
        effort: queued.effort,
        serviceTier: queued.serviceTier ?? null,
        name:
          s.name ||
          queued.input
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join(" ")
            .slice(0, 60),
      }));
      emit("turn/started", { threadId, turn });
      emit("thread/settings/updated", {
        threadId,
        threadSettings: {
          model: queued.model || session.model,
          reasoningEffort: queued.effort || "",
          serviceTier: queued.serviceTier ?? null,
          collaborationMode: { mode: queued.mode },
        },
      });
      compactions.event("turn/started", { threadId, turn });
      emit("lan/inputQueue/updated", { threadId });
      let process = queries.get(threadId);
      const provider = await providers.get(
        backend.id,
        queued.providerId ?? session.providerId,
      );
      const settings = await readSubagentSettings();
      const executionBackend = { ...backend, ...settings };
      const subagentProvider =
        settings.subagentProviderId === "@native"
          ? provider || settings.subagentEffort
            ? nativeSubagentProvider(backend)
            : null
          : settings.subagentProviderId
            ? await providers.get(backend.id, settings.subagentProviderId)
            : null;
      if (
        subagentProvider &&
        !subagentProvider.native &&
        !subagentProvider.models.includes(settings.subagentModel)
      )
        throw new Error("子代理模型已从供应商移除，请重新配置");
      const options = modelOptions(
        provider,
        queued.model || session.model || provider?.models[0],
        queued,
      );
      if (
        process?.ended ||
        (process && process.cwd !== session.cwd) ||
        process?.nativeSessionId !== (session.nativeSessionId || threadId) ||
        process?.providerKey !== JSON.stringify(provider) ||
        process?.review !== queued.review
      ) {
        if (
          process &&
          Object.values(session.backgroundTasks || {}).some((task) =>
            ["running", "pending"].includes(task.status),
          )
        )
          throw new Error("请先停止后台任务，再切换供应商或审查模式");
        process?.close();
        queries.delete(threadId);
        process = undefined;
      }
      if (!process) {
        const sessionRun = await createExecutionSession({
          backend: executionBackend,
          session,
          queued,
          providers,
          subagentProvider,
          save,
          emit,
          broadcast,
          questions,
          observeMessage,
          callConversationTool,
          goals,
          tasks,
          current: () => running.get(threadId),
          finish: (result) => settle(threadId, result),
          failed: (error) => settle(threadId, null, error),
          beginActivity: (message) => beginActivity(threadId, message),
        });
        process = Object.assign(sessionRun, {
          nativeSessionId: session.nativeSessionId || threadId,
          effort: queued.effort,
          serviceTier: queued.serviceTier,
          review: queued.review,
        });
        queries.set(threadId, process);
      } else {
        await process.configureSubagent(executionBackend, subagentProvider);
        await process.query.setPermissionMode(
          queued.mode === "plan" || queued.review
            ? "plan"
            : "bypassPermissions",
        );
        const model = queued.model || session.model;
        if (model && process.model !== model) {
          await process.query.setModel(model);
          process.model = model;
        }
        await process.query.applyFlagSettings({
          effortLevel: queued.effort || null,
          fastMode: options.settings.fastMode,
          ...((provider ||
            subagentProvider ||
            process.subagentSettingsDirty) && {
            env: process.settingsEnvironment(
              model || process.model,
              queued.effort,
            ),
          }),
        });
        process.subagentSettingsDirty = false;
        process.effort = queued.effort;
      }
      active.query = process.query;
      await goals.prepare(threadId, process);
      process.lastActivityAt = Date.now();
      const message = userPrompt(session, queued);
      for (const item of convertMessage(message, turn.id)) {
        turn.items.push(item);
        emit("item/completed", { threadId, turnId: turn.id, item });
      }
      process.input.push(message);
      submitted = true;
      if (active.interrupted) await interrupt(threadId);
    } catch (error) {
      if (queued.peer && !submitted)
        await recordPeerRejection(
          threadId,
          queued.id,
          save,
          "Claude Code 在提交原生输入前结束了处理。",
        );
      await settle(threadId, null, error);
    }
  }
  async function beginActivity(threadId: string, message: SDKMessage) {
    if (running.has(threadId) || closed) return;
    const turn = automaticTurn(message);
    if (!turn) return;
    const anchor = turn.id;
    const process = queries.get(threadId);
    const active: ActiveExecution = {
      query: process?.query,
      interrupted: false,
      turn,
      queued: {},
      automatic: true,
      inputIds: new Set(),
    };
    running.set(threadId, active);
    const session = (await storage.read()).sessions[threadId];
    turn.mode = session.mode || "default";
    if (session.goal?.status === "active") active.goalId = session.goal.id;
    await save(threadId, (s) => ({
      ...s,
      active: { id: anchor, automatic: true },
      turns: { ...s.turns, [anchor]: turn },
      updatedAt: turn.startedAt,
    }));
    emit("turn/started", { threadId, turn });
  }
  function schedule(id: string) {
    if (starting.has(id) || closed) return;
    const operation = Promise.resolve()
      .then(() => drain(id))
      .catch((error) =>
        emit("error", { threadId: id, error: { message: error.message } }),
      )
      .finally(() => {
        starting.delete(id);
      });
    starting.set(id, operation);
  }
  async function command(id: string, text: string) {
    if (running.has(id))
      await new Promise<void>((resolve) => {
        const waiters = idleWaiters.get(id) || new Set<() => void>();
        waiters.add(resolve);
        idleWaiters.set(id, waiters);
      });
    const process = queries.get(id);
    if (!process || process.ended) return null;
    return process.commands.run(text);
  }
  async function interrupt(threadId: string) {
    const active = running.get(threadId);
    if (active) {
      active.interrupted = true;
      const receipt = active.query
        ? await interruptQueuedInput(active.query)
        : undefined;
      for (const id of receipt?.cancelled || []) {
        active.inputIds.delete(id);
        if (
          active.peerInputIds?.delete(id) ||
          (active.queued.peer && active.turn.id === id)
        )
          await recordPeerRejection(
            threadId,
            id,
            save,
            "目标会话取消了尚未消费的回复。",
          );
      }
      if (receipt?.cancelled?.length && active.inputIds.size === 0)
        await settle(threadId);
    }
    await save(threadId, (s) => ({
      ...s,
      queue: (s.queue || []).map((q) => ({ ...q, status: "uncertain" })),
    }));
    return {};
  }
  return {
    running,
    queries,
    mutating,
    goals,
    tasks,
    enqueue,
    steer: createSteer({ running, queries, storage, compactions, save, emit }),
    steerPeer: createPeerSteer(
      { running, queries, storage, compactions, save, emit },
      (id) =>
        !closed &&
        !mutating.has(id) &&
        ![...questions.values()].some((question) => question.threadId === id),
    ),
    interrupt,
    async check() {
      await mkdir(backend.stateDir, { recursive: true, mode: 0o700 });
      const { stdout } = await promisify(execFile)(
        backend.executable,
        ["--version"],
        { timeout: 10000 },
      );
      return stdout.trim();
    },
    async recover() {
      for (const id of await recoverClaudeSessions(storage)) schedule(id);
    },
    resumeQueue: schedule,
    async releaseUnusedThreads(now = Date.now()) {
      const sessions = (await storage.read()).sessions;
      for (const [id, process] of queries) {
        const session = sessions[id];
        if (
          running.has(id) ||
          starting.has(id) ||
          process.commands?.busy ||
          now - process.lastActivityAt < 300000 ||
          session?.goal?.status === "active" ||
          Object.values(session?.backgroundTasks || {}).some((task) =>
            ["running", "pending"].includes(task.status),
          )
        )
          continue;
        process.close();
        queries.delete(id);
      }
    },
    async releaseSession(id: string) {
      if (
        running.has(id) ||
        starting.has(id) ||
        queries.get(id)?.commands?.busy
      )
        throw new Error("请等待当前任务结束后修改对话");
      const process = queries.get(id);
      process?.close();
      queries.delete(id);
      await process?.done;
    },
    close() {
      closed = true;
      for (const active of running.values()) active.interrupted = true;
      for (const process of queries.values()) process.close();
    },
  };
}
