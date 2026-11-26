import { delegationResultItem } from "../../conversation-manager/message.mjs";
import { codexConversationMcpName } from "./conversation-tools.mjs";

export function projectCodexDelegationItem(item) {
  return item.type === "functionCallOutput" &&
    item.namespace === codexConversationMcpName &&
    item.name === "thread_chat_message" &&
    typeof item.output === "string"
    ? delegationResultItem(item, item.output)
    : item;
}

export function projectCodexDelegationTurn(turn) {
  return turn.items
    ? { ...turn, items: turn.items.map(projectCodexDelegationItem) }
    : turn;
}

export function projectCodexDelegationHistory(method, result) {
  if (method === "thread/read" && result?.thread?.turns)
    return {
      ...result,
      thread: {
        ...result.thread,
        turns: result.thread.turns.map(projectCodexDelegationTurn),
      },
    };
  if (method === "thread/turns/list" && result?.data)
    return { ...result, data: result.data.map(projectCodexDelegationTurn) };
  if (method === "thread/items/list" && result?.data)
    return {
      ...result,
      data: result.data.map((entry) => ({
        ...entry,
        item: projectCodexDelegationItem(entry.item),
      })),
    };
  return result;
}
