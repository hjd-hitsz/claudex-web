import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, Users } from "lucide-react";
import { onEvent, rpc, useStore } from "../../store.js";
import { resourceTarget } from "../../../../shared/backend-identity.mjs";
import {
  contextMetrics,
  usageContext,
} from "../../../../shared/delegation-context.mjs";
import { modelChoiceLabel, modelProviderName } from "../../domain/backends.js";
import {
  agentStatusLabels,
  applyAgentEvent,
  mergeAgentHistory,
  subAgents,
  withParentMessages,
} from "../../domain/sub-agents.js";
import { ReadOnlyConversation } from "../conversation/conversation.jsx";
import { IconButton } from "../../ui/primitives.jsx";
import { reasoningEffortLabels } from "../composer/reasoning-effort.jsx";
import { readThreadHistory } from "../../domain/thread-history.js";
import { delegationLabels } from "../../domain/delegation.js";
import { DelegationContext } from "../conversation/delegation-context.jsx";

export function SubAgentConversation({ agent, actions }) {
  const { connected, modelChoices: choices } = useStore();
  const [attempt, retry] = useState(0);
  const [history, update] = useState({ items: [], turns: [], loading: true });
  const [parentMessages, setParentMessages] = useState([]);
  const [messageError, setMessageError] = useState("");
  const scroll = useRef();
  const heading = useRef();
  const follow = useRef(true);
  const delegated = Boolean(agent.delegation);
  const executorId = agent.delegation?.executorThreadId;
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [agent.id]);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let hydrated = false;
    const events = [];
    const liveTurns = new Map();
    let snapshotContext;
    let liveUsage;
    let historyCompactions;
    const liveCompactions = new Set();
    function context() {
      const known = historyCompactions?.size ?? 0;
      const added = [...liveCompactions].filter(
        (id) => !historyCompactions?.has(id),
      ).length;
      return contextMetrics({
        ...snapshotContext,
        ...liveUsage,
        ...((snapshotContext?.compactCount !== undefined || known || added) && {
          compactCount:
            Math.max(snapshotContext?.compactCount ?? 0, known) + added,
        }),
      });
    }
    function applyContext(method, params) {
      const usage =
        method === "thread/tokenUsage/updated" &&
        usageContext(params.tokenUsage);
      if (usage) liveUsage = { ...liveUsage, ...usage };
      const completed =
        method === "item/completed"
          ? [params.item]
          : method === "turn/completed"
            ? (params.turn.items ?? [])
            : [];
      const count = liveCompactions.size;
      for (const item of completed)
        if (item?.type === "contextCompaction" && item.id)
          liveCompactions.add(item.id);
      if (!usage && count === liveCompactions.size) return;
      const metrics = context();
      update((previous) => ({
        ...previous,
        thread: { ...previous.thread, context: metrics },
      }));
    }
    let messageRequest = 0;
    async function loadMessages() {
      if (delegated) return;
      const request = ++messageRequest;
      try {
        const result = await rpc("lan/agents/messages", { threadId: agent.id });
        if (cancelled || request !== messageRequest) return;
        setParentMessages(result.messages || []);
        setMessageError("");
      } catch (error) {
        if (!cancelled && request === messageRequest)
          setMessageError(error.message);
      }
    }
    loadMessages();
    update((previous) => ({ ...previous, loading: true, error: "" }));
    const unsubscribe = onEvent(({ method, params: p }) => {
      if (
        p?.threadId === agent.parentId &&
        p.item &&
        ["item/started", "item/completed"].includes(method) &&
        subAgents([p.item]).some((entry) => entry.id === agent.id)
      )
        loadMessages();
      if (p?.threadId !== agent.id) return;
      applyContext(method, p);
      if (["turn/started", "turn/completed"].includes(method)) {
        loadMessages();
        liveTurns.set(p.turn.id, { ...liveTurns.get(p.turn.id), ...p.turn });
        update((previous) => ({
          ...previous,
          turns: [
            {
              ...previous.turns.find((turn) => turn.id === p.turn.id),
              ...p.turn,
            },
            ...previous.turns.filter((turn) => turn.id !== p.turn.id),
          ],
        }));
      }
      if (
        [
          "item/started",
          "item/completed",
          "item/agentMessage/delta",
          "item/commandExecution/outputDelta",
          "item/reasoning/summaryTextDelta",
        ].includes(method)
      ) {
        if (!hydrated) events.push({ method, params: p });
        update((previous) => ({
          ...previous,
          items: applyAgentEvent(previous.items, method, p),
        }));
      }
    });
    async function pages(method, params) {
      const data = [];
      let cursor;
      do {
        const page = await rpc(method, {
          threadId: agent.id,
          ...params,
          ...(cursor ? { cursor } : {}),
        });
        if (cancelled) return [];
        data.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return data;
    }
    async function load() {
      try {
        const [{ thread }, turns, records] = await Promise.all([
          rpc("thread/read", { threadId: agent.id, includeTurns: false }),
          pages("thread/turns/list", {
            limit: 20,
            itemsView: "notLoaded",
            sortDirection: "desc",
          }),
          readThreadHistory(rpc, agent.id, {
            current: () => !cancelled,
            sortDirection: "asc",
          }),
        ]);
        if (cancelled) return;
        snapshotContext = {
          ...usageContext(thread.tokenUsage),
          ...thread.context,
        };
        historyCompactions = new Set(
          records
            .filter(({ type, id }) => type === "contextCompaction" && id)
            .map(({ id }) => id),
        );
        const items = mergeAgentHistory(records, events);
        events.length = 0;
        hydrated = true;
        update({
          thread: { ...thread, context: context() },
          items,
          turns: [
            ...[...liveTurns.values()].reverse().map((turn) => ({
              ...turns.find((entry) => entry.id === turn.id),
              ...turn,
            })),
            ...turns.filter((turn) => !liveTurns.has(turn.id)),
          ],
          loading: false,
        });
      } catch (error) {
        events.length = 0;
        hydrated = true;
        if (!cancelled)
          update((previous) => ({
            ...previous,
            loading: false,
            error: error.message,
          }));
      }
    }
    load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [agent.id, agent.parentId, delegated, executorId, connected, attempt]);
  const items = withParentMessages(history.items, parentMessages);
  useEffect(() => {
    const element = scroll.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [history.items, parentMessages]);
  const turn = history.turns[0];
  const status = delegated ? agent.status : turn?.status || agent.status;
  const model = history.thread?.model || agent.model;
  const backendId =
    agent.delegation?.target || resourceTarget(agent.id).backendId;
  const providerId = history.thread?.providerId || "";
  const choice = choices?.find(
    (entry) =>
      entry.backendId === backendId &&
      entry.providerId === providerId &&
      (entry.model === model || entry.resolvedModel === model),
  );
  const modelLabel = modelChoiceLabel(
    choice || {
      model,
      providerName: modelProviderName(choices, backendId, providerId),
    },
  );
  const effort = history.thread?.reasoningEffort || agent.reasoningEffort;
  return (
    <section
      className="subagent-conversation"
      data-delegated={delegated || undefined}
      aria-label={agent.name + (delegated ? " 委派对话" : "的对话")}
      ref={heading}
      tabIndex={-1}
    >
      <div className="panel-heading">
        <span>
          <Users size={16} />
          <strong>{agent.name}</strong>
        </span>
        {actions}
        {!delegated && (
          <IconButton
            icon={RefreshCw}
            title="刷新子代理对话"
            onClick={() => retry((value) => value + 1)}
          />
        )}
      </div>
      <div
        className="subagent-meta"
        role="group"
        aria-label="执行信息"
        tabIndex={0}
      >
        <span data-status={status}>
          {status === "completed" ? <CheckCircle2 size={13} /> : null}
          {(delegated ? delegationLabels[status] : agentStatusLabels[status]) ||
            "状态待更新"}
        </span>
        {model && <span>{modelLabel}</span>}
        {effort && (
          <span>思考强度 {reasoningEffortLabels[effort] || effort}</span>
        )}
        <DelegationContext context={history.thread?.context} />
      </div>
      <div
        className="subagent-history"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            100;
        }}
      >
        {connected && history.loading && (
          <p className="subagent-notice" role="status">
            <LoaderCircle size={14} className="spin" />
            正在读取子代理对话…
          </p>
        )}
        {history.error && (
          <div className="subagent-notice" role="alert">
            <p>{history.error}</p>
            <button
              className="secondary"
              onClick={() => retry((value) => value + 1)}
            >
              重试读取
            </button>
          </div>
        )}
        {messageError && (
          <div className="subagent-notice" role="alert">
            <p>读取主代理消息失败：{messageError}</p>
            <button
              className="secondary"
              onClick={() => retry((value) => value + 1)}
            >
              重试读取
            </button>
          </div>
        )}
        {!history.loading && !history.error && !items.length && (
          <p className="subagent-notice">
            {delegated && !executorId ? "等待执行端开始。" : "暂无对话记录。"}
          </p>
        )}
        <ReadOnlyConversation
          items={items}
          cwd={history.thread?.cwd}
          turns={history.turns}
        />
      </div>
    </section>
  );
}
