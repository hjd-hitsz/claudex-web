import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { ConversationTool } from "./conversation-protocol.d.mts";
import type {
  ConversationToolReply,
  WorkerPacket,
} from "./worker-protocol.d.mts";

type Pending = {
  connection: Socket;
  settle: (result?: unknown, error?: string) => void;
};

export function workerConversationTools(
  selectConnection: () => Socket | undefined,
  send: (connection: Socket, packet: WorkerPacket) => void,
) {
  const pending = new Map<string, Pending>();
  const call: ConversationTool = (context, name, args) => {
    const connection = selectConnection();
    if (!connection || connection.destroyed)
      return Promise.reject(new Error("Claudex 会话管理器正在重新连接"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending
          .get(id)
          ?.settle(undefined, "会话工具等待超时，请按原请求 ID 核对");
      }, 30000);
      pending.set(id, {
        connection,
        settle(result, error) {
          clearTimeout(timer);
          pending.delete(id);
          if (error) reject(new Error(error));
          else resolve(result);
        },
      });
      send(connection, { kind: "conversationTool", id, context, name, args });
    });
  };
  return {
    call,
    accept(connection: Socket, reply: ConversationToolReply) {
      const request = pending.get(reply.id);
      if (request?.connection === connection)
        request.settle(reply.result, reply.error);
    },
    disconnect(connection: Socket) {
      for (const request of pending.values())
        if (request.connection === connection)
          request.settle(
            undefined,
            "Claudex 会话管理器连接中断，请按原请求 ID 核对",
          );
    },
  };
}
