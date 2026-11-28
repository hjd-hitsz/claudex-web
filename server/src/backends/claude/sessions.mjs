import {
  recoverAgents,
  agentTurns,
  removeUnboundCompactionAgents,
} from "./agent-history.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createHistoryPages } from "../history-pages.mjs";
import {
  createHistoryActions,
  forkHistory,
  retainedDetails,
} from "./history-actions.mjs";
import { page } from "./history.mjs";
import {
  assertClaudeSecretaryHistory,
  claudeSecretaryMode,
  claudeSecretaryUpgradeRequired,
  secretaryHistoryVersion,
} from "./secretary-policy.mjs";
import { historyTurns, visibleSessionMessages } from "./messages.mjs";
import { countClaudeCompactions } from "./compaction-count.mjs";
import { conversationMethods } from "../../../../shared/product-contract.mjs";

export function createClaudeSessions({
  config,
  storage,
  readSession,
  runtime,
  compactions,
  notify,
  assertReady,
  readLegacyDelegationMode = async () => false,
  readTokenUsage = async (session) => session.tokenUsage,
}) {
  runtime.mutating ||= new Set();
  const history = createHistoryPages(readHistory, page);
  async function update(id, patch) {
    await storage.update((data) => ({
      ...data,
      sessions: { ...data.sessions, [id]: { ...data.sessions[id], ...patch } },
    }));
  }
  async function session(id) {
    const data = await storage.read();
    if (id?.startsWith("agent/")) {
      const [, parentId] = id.split("/");
      const parent = data.sessions[parentId];
      if (!parent || parent.deleted) throw new Error("对话不存在");
      let agent = parent.agents?.[id];
      if (!agent && parent.initialized) {
        await turns(parentId);
        agent = (await storage.read()).sessions[parentId].agents?.[id];
      }
      if (agent)
        return {
          ...parent,
          id,
          name: agent.name,
          parentId,
          parentNativeId:
            agent.parentNativeId || parent.nativeSessionId || parentId,
          agentId: agent.agentId,
          turns: {},
          turnIds: {},
          extraItems: {},
        };
    }
    const value = data.sessions[id];
    if (!value || value.deleted) throw new Error("对话不存在");
    return value;
  }
  function thread(s) {
    return {
      ...s,
      queue: undefined,
      turns: undefined,
      active: undefined,
      status: { type: runtime.running.has(s.id) ? "active" : "idle" },
      path: s.archived ? "/archived_sessions/" : "",
      preview: s.name || "新对话",
    };
  }
  function nativeMessages(s, dir = s.historySearchAll ? undefined : s.cwd) {
    return s.initialized
      ? readSession("getSessionMessages", s.nativeSessionId || s.id, {
          dir,
          includeSystemMessages: true,
          includeCompactedHistory: true,
        })
      : [];
  }
  async function readHistory(id) {
    let s = await session(id);
    const dir = s.historySearchAll ? undefined : s.cwd;
    if (s.agentId)
      return {
        turns: agentTurns(
          await readSession(
            "getSubagentMessages",
            s.parentNativeId || s.parentId,
            s.agentId,
            { dir },
          ),
        ),
      };
    const nativeId = s.nativeSessionId || id;
    const [messages, agentIds] = s.initialized
      ? await Promise.all([
          nativeMessages(s, dir),
          readSession("listSubagents", nativeId, { dir }),
        ])
      : [[], []];
    s = await session(id);
    const records = historyTurns(
      visibleSessionMessages(messages, s.internalInputIds).map((message) => {
        const previousId = message.forkedFrom?.messageUuid;
        const peer =
          message.type === "user" &&
          (s.peerInputs?.[message.uuid] ?? s.peerInputs?.[previousId]);
        return peer
          ? {
              ...message,
              peerMessageId: peer.sourceMessageId ?? previousId ?? message.uuid,
              origin: {
                kind: "peer",
                from: peer.from.threadId,
                name: peer.from.title,
              },
            }
          : message;
      }),
      s.turns,
      s.turnIds,
      s.inputTurns,
    );
    const byId = new Map(records.map((turn) => [turn.id, turn]));
    const savedOnly = Object.values(s.turns || {})
      .filter((turn) => !byId.has(turn.id) && turn.items?.length)
      .map((turn) => ({ ...turn, items: [...turn.items] }));
    if (savedOnly.length) {
      const time = (turn) => turn.startedAt ?? turn.completedAt ?? Infinity;
      records.push(...savedOnly);
      records.sort((a, b) => time(a) - time(b));
      for (const turn of savedOnly) byId.set(turn.id, turn);
    }
    for (const item of Object.values(s.extraItems || {})) {
      const turn = byId.get(item.turnId);
      if (turn && !turn.items.some((i) => i.id === item.id))
        turn.items.push(item);
    }
    if (s.initialized) {
      removeUnboundCompactionAgents(records, s.agents, agentIds);
      const agents = await recoverAgents(
        { ...s, running: runtime.running.has(s.id) },
        records,
        readSession,
        agentIds,
      );
      if (!isDeepStrictEqual(agents, s.agents || {}))
        await storage.update((data) => {
          const current = data.sessions[s.id];
          if (
            current?.deleted ||
            current?.nativeSessionId !== s.nativeSessionId
          )
            return data;
          return {
            ...data,
            sessions: {
              ...data.sessions,
              [s.id]: { ...current, agents: { ...agents, ...current.agents } },
            },
          };
        });
    }
    return {
      turns: records.map((turn, index) => ({ ...turn, turnNumber: index + 1 })),
      compactCount: countClaudeCompactions(messages),
    };
  }
  const turns = async (id) => (await readHistory(id)).turns;
  const revert = createHistoryActions({
    session,
    turns,
    update,
    readSession,
    running: runtime.running,
    compactions,
    notify,
  });

  const methods = new Set([
    ...conversationMethods,
    "lan/agents/messages",
    "lan/delegation/mode/set",
    "lan/delegation/secretary/continue",
  ]);
  async function perform(method, p) {
    if (method === "lan/agents/messages")
      return {
        messages: (await turns(p.threadId)).flatMap((turn) =>
          turn.items.filter(
            (item) => item.type === "userMessage" && item.authorLabel,
          ),
        ),
      };
    if (["thread/revert", "thread/rollback"].includes(method)) return revert(p);
    if (method === "thread/list") {
      const [data, native] = await Promise.all([
        storage.read(),
        readSession("listSessions", {}),
      ]);
      const aliases = new Set(
        Object.values(data.sessions).flatMap((s) => [
          s.id,
          s.nativeSessionId,
          ...(s.nativeAliases || []),
        ]),
      );
      const discovered = {};
      for (const n of native)
        if (!aliases.has(n.sessionId))
          discovered[n.sessionId] = {
            id: n.sessionId,
            name: n.customTitle || n.summary,
            cwd: n.cwd,
            createdAt: (n.createdAt || n.lastModified) / 1000,
            updatedAt: n.lastModified / 1000,
            initialized: true,
            turns: {},
            queue: [],
          };
      const merged = Object.keys(discovered).length
        ? await storage.update((current) => ({
            ...current,
            sessions: { ...discovered, ...current.sessions },
          }))
        : data;
      return page(
        Object.values(merged.sessions)
          .filter(
            (s) =>
              !s.deleted &&
              Boolean(s.archived) === Boolean(p.archived) &&
              (!p.searchTerm || s.name?.includes(p.searchTerm)),
          )
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .map(thread),
        p,
      );
    }
    if (method === "lan/delegation/secretary/continue") {
      const s = await session(p.threadId);
      const projected = s.initialized
        ? await readSession(
            "projectSecretaryHistory",
            s.nativeSessionId || s.id,
            {
              dir: s.historySearchAll ? undefined : s.cwd,
              internalIds: s.internalInputIds,
            },
          )
        : { sessionId: randomUUID(), initialized: false };
      const now = Date.now() / 1000;
      const next = {
        id: projected.sessionId,
        cwd: s.cwd,
        model: s.model,
        providerId: s.providerId,
        effort: s.effort,
        serviceTier: s.serviceTier,
        name: s.name,
        forkedFromId: s.id,
        createdAt: now,
        updatedAt: now,
        initialized: projected.initialized,
        delegationMode: true,
        secretaryHistoryVersion,
        turns: {},
        queue: [],
      };
      await update(next.id, next);
      return {
        thread: thread(next),
        model: next.model,
        providerId: next.providerId,
        reasoningEffort: next.effort,
        cwd: next.cwd,
      };
    }
    if (method === "thread/start") {
      assertReady();
      const id = randomUUID(),
        now = Date.now() / 1000;
      const s = {
        id,
        cwd: p.cwd || config.defaultCwd,
        model: p.model,
        serviceTier: p.serviceTier ?? null,
        providerId: p.providerId ?? "",
        threadSource: p.threadSource,
        createdAt: now,
        updatedAt: now,
        initialized: false,
        delegationMode: p.delegationMode === true,
        ...(p.delegationMode === true && { secretaryHistoryVersion }),
        turns: {},
        queue: [],
      };
      await update(id, s);
      return { thread: thread(s), model: s.model, cwd: s.cwd };
    }
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "lan/delegation/mode/set") {
      if (p.delegationMode !== false)
        throw new Error("开启委派模式需要创建秘书续接。");
      await storage.update((data) => {
        const current = data.sessions[p.threadId];
        if (!current || current.deleted) throw new Error("对话不存在");
        data.sessions[p.threadId] = {
          ...current,
          delegationMode: false,
          secretaryHistoryVersion: undefined,
        };
        return data;
      });
      return { delegationMode: p.delegationMode };
    }
    if (["thread/read", "thread/resume"].includes(method)) {
      const s = await session(p.threadId);
      const delegationMode = await claudeSecretaryMode(
        s,
        readLegacyDelegationMode,
      );
      if (method === "thread/resume")
        await assertClaudeSecretaryHistory(s, readLegacyDelegationMode);
      return {
        thread: {
          ...thread(s),
          delegationMode,
          secretaryContinuationRequired: claudeSecretaryUpgradeRequired(
            s,
            delegationMode,
          ),
          tokenUsage: await readTokenUsage(s),
          ...(p.includeTurns && { turns: await turns(s.id) }),
        },
        delegationMode,
        cwd: s.cwd,
        model: s.model,
        reasoningEffort: s.effort || "",
        collaborationMode: { mode: s.mode || "default" },
        serviceTier: s.serviceTier ?? null,
      };
    }
    if (["thread/turns/list", "thread/items/list"].includes(method))
      return history.read(method, p);
    if (
      [
        "thread/name/set",
        "thread/archive",
        "thread/unarchive",
        "thread/delete",
        "thread/fork",
      ].includes(method)
    ) {
      const s = await session(p.threadId);
      if (runtime.running.has(s.id)) throw new Error("请等待此对话任务结束");
      if (method === "thread/fork") {
        const delegationMode = await assertClaudeSecretaryHistory(
          s,
          readLegacyDelegationMode,
        );
        if (!s.initialized) throw new Error("请在首轮完成后创建分支");
        const records = await turns(s.id);
        const index = p.lastTurnId
          ? records.findIndex((turn) => turn.id === p.lastTurnId)
          : records.length - 1;
        if (index < 0) throw new Error("分支起点已变化，请刷新历史后重试");
        const retained = records.slice(0, index + 1);
        const fork = await forkHistory(readSession, s, retained);
        const sessionId = fork.nativeSessionId;
        const copy = {
          ...s,
          id: sessionId,
          delegationMode,
          ...fork,
          nativeAliases: [sessionId],
          forkedFromId: s.id,
          tokenUsage: index === records.length - 1 ? s.tokenUsage : null,
          queue: [],
          active: null,
          turns: Object.fromEntries(
            retained.map((turn) => [
              turn.id,
              { ...turn, ...fork.historyAnchors?.[turn.id] },
            ]),
          ),
          ...retainedDetails(await session(s.id), retained, sessionId),
          archived: false,
          createdAt: Date.now() / 1000,
          updatedAt: Date.now() / 1000,
        };
        await update(sessionId, copy);
        return { thread: thread(copy) };
      }
      if (method === "thread/name/set") {
        if (typeof p.name !== "string" || !p.name.trim())
          throw new Error("请输入对话名称");
        p = { ...p, name: p.name.trim() };
        if (s.initialized)
          await readSession(
            "renameSession",
            s.nativeSessionId || s.id,
            p.name,
            { dir: s.historySearchAll ? undefined : s.cwd },
          );
        await update(s.id, { name: p.name });
        notify("thread/name/updated", { threadId: s.id, threadName: p.name });
      } else {
        const deleted = method === "thread/delete";
        if (deleted && s.initialized)
          await readSession("deleteSession", s.nativeSessionId || s.id, {
            dir: s.historySearchAll ? undefined : s.cwd,
          });
        await update(
          s.id,
          deleted
            ? { deleted: true }
            : { archived: method === "thread/archive" },
        );
        notify(
          deleted
            ? "thread/deleted"
            : method === "thread/archive"
              ? "thread/archived"
              : "thread/unarchived",
          { threadId: s.id },
        );
      }
      return {};
    }

    throw new Error(`未知对话操作：${method}`);
  }
  const mutations = new Set([
    "lan/delegation/secretary/continue",
    "thread/revert",
    "thread/rollback",
    "thread/fork",
    "thread/name/set",
    "thread/archive",
    "thread/unarchive",
    "thread/delete",
  ]);
  const operations = new Map();
  async function request(method, p) {
    if (method === "thread/list")
      await Promise.allSettled([...operations.values()]);
    if (!mutations.has(method)) return perform(method, p);
    const id = p.threadId;
    if (runtime.mutating.has(id)) throw new Error("正在更新此对话，请稍候");
    runtime.mutating.add(id);
    const operation = (async () => {
      const s = await session(id);
      if (runtime.running.has(id) || s.queue?.length || compactions.busy(id))
        throw new Error("请等待此对话任务结束");
      if (method === "thread/revert" || method === "thread/rollback")
        await assertClaudeSecretaryHistory(s, readLegacyDelegationMode);
      if (method !== "lan/delegation/secretary/continue")
        await runtime.releaseSession?.(id);
      const result = await perform(method, p);
      if (
        ["thread/revert", "thread/rollback", "thread/delete"].includes(method)
      )
        history.invalidate(id);
      return result;
    })();
    operations.set(id, operation);
    try {
      return await operation;
    } finally {
      runtime.mutating.delete(id);
      operations.delete(id);
    }
  }
  return {
    close: history.close,
    request,
    handles: (method) => methods.has(method),
    session,
    turns,
    compactCount: async (id) =>
      countClaudeCompactions(await nativeMessages(await session(id))),
    update,
  };
}
