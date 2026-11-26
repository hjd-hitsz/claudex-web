import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createCodexAdapter } from "../codex/adapter.mjs";
import { createClaudeWorkerAdapter } from "../claude/worker-client.mjs";
import { createBackendConfiguration } from "../configuration.mjs";
import { runtimeIdentity } from "../../conversation-manager/address.mjs";
import { createBackgroundService } from "../codex/background-service.mjs";
import { codexFullAccess } from "../codex/subscriptions.mjs";
import { taskRequest } from "../../../../packages/background-terminal/client.mjs";

const constructors = {
  codex: createCodexAdapter,
  claude: createClaudeWorkerAdapter,
};
export const delegationMarker = (id) => `[Claudex delegation step: ${id}]`;
export const executorLabel = (target) =>
  target === "codex" ? "Codex" : "Claude Code";

export function createExecutors({ config, version, onEvent }) {
  const configuration = createBackendConfiguration(config);
  const adapters = new Map();
  const background = createBackgroundService(config);

  function connection(backend) {
    const runtimeId = runtimeIdentity(backend);
    if (adapters.has(runtimeId)) return adapters.get(runtimeId);
    const entry = {
      backend,
      runtimeId,
      ready: undefined,
      client: { readyState: 1 },
      replies: new Map(),
      subscriptions: new Set(),
      lifecycle: new EventEmitter(),
    };
    adapters.set(runtimeId, entry);
    entry.adapter = constructors[backend.type]({
      config,
      version,
      backend,
      background,
      backgroundEnabled: () =>
        backend.backgroundTerminalEnabled && background.available,
      readSubagentSettings: () =>
        configuration.readSubagentSettings(backend.id),
      send: (_client, message) => entry.replies.get(message.id)?.(message),
      broadcast: (message) => {
        if (message.method === "turn/completed")
          entry.lifecycle.emit("completed", message.params);
        if (message.method === "lan/state") {
          if (message.params.ready) entry.lifecycle.emit("ready");
          else entry.subscriptions.clear();
        }
        onEvent(entry, message);
      },
    });
    entry.ready = Promise.resolve()
      .then(() => entry.adapter.connect())
      .catch((error) => {
        entry.adapter.close();
        adapters.delete(runtimeId);
        throw error;
      });
    return entry;
  }

  async function resolveExecutor(task) {
    const backend = (await configuration.read()).backends.find(
      ({ id }) => id === task.target,
    );
    if (!backend || (!backend.enabled && !task.executor))
      throw new Error("委派执行端已停用");
    if (
      backend.type === "codex" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(backend.url).hostname,
      )
    )
      throw new Error("agy 委派使用共享本机工作区，需要本机 Codex app-server");
    const id = runtimeIdentity(backend);
    if (task.executor && task.executor.runtimeId !== id)
      throw new Error("原委派执行实例已变更，等待核对");
    const entry = connection(backend);
    await entry.ready;
    return entry;
  }

  async function call(entry, method, params) {
    if (!entry.adapter.ready)
      throw new Error(`${executorLabel(entry.backend.id)} 正在连接`);
    const id = randomUUID();
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("原生执行端响应超时")),
          30000,
        );
        entry.replies.set(id, ({ result, error }) => {
          if (error)
            reject(
              Object.assign(new Error(error.message), {
                nativeCode: error.code,
              }),
            );
          else resolve(result);
        });
        Promise.resolve()
          .then(() =>
            entry.adapter.receive(entry.client, { id, method, params }),
          )
          .catch(reject);
      });
    } finally {
      clearTimeout(timer);
      entry.replies.delete(id);
    }
  }

  async function readHistory(entry, method, params) {
    if (!entry.adapter.ready) {
      try {
        await once(entry.lifecycle, "ready", {
          signal: AbortSignal.timeout(8000),
        });
      } catch (error) {
        if (error.name !== "AbortError") throw error;
        throw new Error(
          `${executorLabel(entry.backend.id)} 历史服务连接超时，请重试读取`,
        );
      }
    }
    return call(entry, method, params);
  }
  function startParams(task) {
    const { model, providerId } = task.selection;
    return {
      cwd: task.cwd,
      ...(model && { model }),
      ...(providerId && { providerId }),
      ...(task.target === "codex" && codexFullAccess),
    };
  }

  function turnParams(task) {
    const step = task.steps.at(-1);
    const original =
      step.original ?? (task.steps.length === 1 ? task.original : []);
    const lead = [
      delegationMarker(step.id),
      "你是已受理此任务的技术执行端。直接执行下方具体任务，将结果交回 Antigravity 秘书。",
      task.scope === "research"
        ? "执行只读调查。在答复中给出技术结论、具体文件位置、理由、证据和待确认事项。"
        : "负责技术执行、实现和验证。文档写作由 agy 完成，请在答复给出写作材料。",
      original.length > 0 &&
        "以下用户原话用于核对授权范围和验收要求。用户交给秘书的委派流程和文档写作由秘书负责。",
    ]
      .filter(Boolean)
      .join("\n");
    const { model, effort, providerId } = task.selection;
    return {
      threadId: task.executor.threadId,
      input: [
        { type: "text", text: lead },
        ...original,
        { type: "text", text: "本轮具体任务：\n" + step.request },
      ],
      ...(model && { model }),
      ...(effort && { effort }),
      ...(providerId && { providerId }),
      ...(task.target === "claude" && {
        delegation: task.scope,
        collaborationMode: {
          mode: task.scope === "research" ? "plan" : "default",
        },
      }),
    };
  }

  async function attach(entry, task) {
    const threadId = task.executor.threadId;
    if (task.target !== "codex" || entry.subscriptions.has(threadId)) return;
    await call(entry, "thread/resume", {
      ...startParams(task),
      threadId,
      excludeTurns: true,
    });
    entry.subscriptions.add(threadId);
  }

  async function backgrounds(entry, threadId) {
    const terminals = [];
    let cursor;
    do {
      const page = await call(entry, "thread/backgroundTerminals/list", {
        threadId,
        ...(cursor && { cursor }),
      });
      terminals.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const { jobs } =
      entry.backend.type === "codex" &&
      background.available &&
      background.listening()
        ? await taskRequest(background.directory, "tool", {
            name: "background_list",
            args: {},
            threadId,
            expectedUpstream: new URL(entry.backend.url).href,
          })
        : { jobs: [] };
    return { terminals, jobs };
  }

  async function takeover(entry, task) {
    const { threadId } = task.executor;
    const prior = task.steps
      .slice(0, -1)
      .filter(({ supersededAt }) => supersededAt);
    if (!prior.some(({ submittedAt, turnId }) => submittedAt || turnId)) return;
    if (task.target === "claude") {
      const { entries } = await call(entry, "lan/inputQueue/list", {
        threadId,
      });
      for (const queued of entries)
        if (
          prior.some(
            (step) =>
              step.turnId === queued.id ||
              queued.input?.[0]?.text?.startsWith(delegationMarker(step.id)),
          )
        )
          await call(entry, "lan/inputQueue/cancel", {
            threadId,
            id: queued.id,
          });
    }
    const readActive = async () => {
      const { thread } = await call(entry, "thread/read", {
        threadId,
        includeTurns: true,
      });
      return (
        entry.adapter.state().params.activeTurns?.[threadId] ||
        thread.turns?.findLast(({ status }) => status === "inProgress")?.id
      );
    };
    const turnId = await readActive();
    if (!turnId) return;
    const ended = Promise.withResolvers();
    const complete = (event) => {
      if (event.threadId === threadId && event.turn?.id === turnId)
        ended.resolve();
    };
    entry.lifecycle.on("completed", complete);
    let timeout;
    try {
      try {
        await call(entry, "turn/interrupt", { threadId, turnId });
      } catch (error) {
        if ((await readActive()) === turnId) throw error;
        return;
      }
      if ((await readActive()) !== turnId) return;
      await Promise.race([
        ended.promise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("等待原生轮次中断超时")),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      entry.lifecycle.off("completed", complete);
    }
  }

  return {
    attach,
    backgrounds,
    resolve: resolveExecutor,
    call,
    readHistory,
    startParams,
    turnParams,
    takeover,
    async stop(entry, task) {
      const { threadId } = task.executor;
      const step = task.steps.at(-1);
      const turnId =
        entry.adapter.state().params.activeTurns?.[threadId] ||
        (!step.progress?.length && step.turnId);
      if (turnId) await call(entry, "turn/interrupt", { threadId, turnId });
      await call(entry, "thread/backgroundTerminals/clean", { threadId });
    },
    async respond(entry, request, result, error) {
      const pending = entry.adapter.state().params.questions || [];
      if (
        !pending.some(
          (candidate) =>
            String(candidate.id) === String(request.id) &&
            candidate.params?.threadId === request.params.threadId &&
            candidate.params?.turnId === request.params.turnId,
        )
      )
        throw new Error("原生请求已结束或连接已变更");
      await entry.adapter.receive(entry.client, {
        id: request.id,
        result,
        error,
      });
    },
    close() {
      for (const entry of adapters.values()) entry.adapter.close();
    },
  };
}

export function executorResult(turn) {
  const items = turn.items || [];
  const replies = items.filter(
    ({ type }) => type === "agentMessage" || type === "plan",
  );
  const final = replies.filter(
    ({ phase, type }) => phase === "final_answer" || type === "plan",
  );
  return {
    answer: (final.length
      ? final
      : replies.filter(({ phase }) => !phase).slice(-1)
    )
      .map(({ text }) => text)
      .filter(Boolean)
      .join("\n\n"),
    evidence: items
      .filter(({ type }) =>
        ["commandExecution", "webSearch", "mcpToolCall"].includes(type),
      )
      .map(({ id, type, command, status, exitCode, aggregatedOutput }) => ({
        id,
        type,
        command,
        status,
        exitCode,
        output: aggregatedOutput?.slice(-6000),
      })),
    artifacts: items
      .filter(({ type }) => type === "fileChange")
      .flatMap(({ changes }) =>
        (changes || []).map(({ path, kind }) => ({ path, kind })),
      ),
    ...(turn.error && { error: turn.error.message }),
  };
}
