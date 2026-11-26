export const agyHistoryMethods = new Set([
  "thread/read",
  "thread/items/list",
  "thread/turns/list",
]);

const delegationPrefix = "delegation/";
export const delegationThreadId = (id) => delegationPrefix + id;
export const isDelegationThread = (id) =>
  typeof id === "string" && id.startsWith(delegationPrefix);

const historyEvents = new Set([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
]);

function visibleItem(item, authorLabel) {
  if (
    item.type !== "userMessage" ||
    !item.content?.[0]?.text?.startsWith("[Claudex delegation step:")
  )
    return item;
  const assignment = item.content.at(-1)?.text;
  const prefix = "本轮具体任务：\n";
  if (!assignment?.startsWith(prefix)) return item;
  return {
    ...item,
    authorLabel,
    content: [
      { type: "text", text: assignment.slice(prefix.length) },
      ...item.content.filter(({ type }) => type !== "text"),
    ],
  };
}

function visibleTurn(turn, authorLabel) {
  return turn.items
    ? {
        ...turn,
        items: turn.items.map((item) => visibleItem(item, authorLabel)),
      }
    : turn;
}

export function isDelegationHistoryEvent({ id, method }) {
  return id === undefined && historyEvents.has(method);
}

export function delegationHistoryEvent(task, message) {
  const { item, turn } = message.params;
  return {
    method: message.method,
    params: {
      ...message.params,
      threadId: delegationThreadId(task.id),
      ...(item && {
        item: visibleItem(item, task.sourceName ?? "Antigravity"),
      }),
      ...(turn && {
        turn: visibleTurn(turn, task.sourceName ?? "Antigravity"),
      }),
    },
  };
}

export async function readDelegationHistory(
  store,
  executor,
  method,
  params,
  validateParent,
) {
  const agentId = params.threadId;
  const state = await store.read();
  const task = state.tasks[agentId.slice(delegationPrefix.length)];
  if (!task) throw new Error("找不到委派任务");
  validateParent?.(state, task.parentId);
  const author = task.sourceName ?? "Antigravity";
  if (method === "lan/agents/messages") return { messages: [] };
  if (!task.executor) {
    if (method === "thread/read")
      return {
        thread: { id: agentId, cwd: task.cwd, model: task.selection.model },
      };
    return { data: [], nextCursor: null };
  }
  const entry = await executor.resolve(task);
  const result = await executor.readHistory(entry, method, {
    ...params,
    threadId: task.executor.threadId,
    ...(task.target === "codex" &&
      method === "thread/items/list" && { includeStreaming: true }),
  });
  if (method === "thread/read")
    return {
      ...result,
      thread: {
        ...result.thread,
        id: agentId,
        ...(result.thread.turns && {
          turns: result.thread.turns.map((turn) => visibleTurn(turn, author)),
        }),
      },
    };
  return {
    ...result,
    data:
      method === "thread/items/list"
        ? result.data.map((entry) => ({
            ...entry,
            item: visibleItem(entry.item, author),
          }))
        : result.data.map((turn) => visibleTurn(turn, author)),
  };
}
