import { conversationMessageItem } from "../../conversation-manager/message.mjs";
import { codexConversationMcpName } from "./conversation-tools.mjs";

export function projectCodexDeliveryItem(item) {
  return item.type === "functionCallOutput" &&
    item.namespace === codexConversationMcpName &&
    item.name === "thread_chat_message" &&
    typeof item.output === "string"
    ? conversationMessageItem(item, item.output, {
        serverName: codexConversationMcpName,
      })
    : item;
}

export function projectCodexDeliveryTurn(turn) {
  return turn.items
    ? { ...turn, items: turn.items.map(projectCodexDeliveryItem) }
    : turn;
}

export function projectCodexDeliveryHistory(method, result) {
  if (method === "thread/read" && result?.thread?.turns)
    return {
      ...result,
      thread: {
        ...result.thread,
        turns: result.thread.turns.map(projectCodexDeliveryTurn),
      },
    };
  if (method === "thread/turns/list" && result?.data)
    return { ...result, data: result.data.map(projectCodexDeliveryTurn) };
  if (method === "thread/items/list" && result?.data)
    return {
      ...result,
      data: result.data.map((entry) => ({
        ...entry,
        item: projectCodexDeliveryItem(entry.item),
      })),
    };
  return result;
}
