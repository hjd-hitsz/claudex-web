import { randomUUID } from "node:crypto";
import type {
  SDKMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

type NativeCommand = {
  resolve: (result: SDKResultSuccess) => void;
  reject: (error: unknown) => void;
};

// 原生本地命令共用输入流，按独立 UUID 结算；命令确认与用户轮次、模型输入分别处理。
export function createNativeCommands(
  input: { push(message: SDKUserMessage): void },
  sessionId: string,
  record: (uuid: string) => Promise<unknown>,
) {
  const pending = new Map<string, NativeCommand>();
  return {
    get busy() {
      return pending.size > 0;
    },
    async run(text: string) {
      const uuid = randomUUID();
      await record(uuid);
      return new Promise<SDKResultSuccess>((resolve, reject) => {
        pending.set(uuid, { resolve, reject });
        input.push({
          type: "user",
          uuid,
          session_id: sessionId,
          parent_tool_use_id: null,
          isSynthetic: true,
          message: { role: "user", content: text },
        });
      });
    },
    accept(message: SDKMessage) {
      if (message.type === "result") {
        const ids = message.user_message_uuids || [message.user_message_uuid];
        let matched = false;
        for (const id of ids) {
          if (id === undefined) continue;
          const request = pending.get(id);
          if (!request) continue;
          matched = true;
          pending.delete(id);
          if (message.is_error || message.subtype !== "success")
            request.reject(
              new Error(
                ("result" in message && message.result) ||
                  ("errors" in message
                    ? message.errors?.join("\n")
                    : undefined),
              ),
            );
          else request.resolve(message);
        }
        return matched;
      }
      return (
        message.type === "user" &&
        message.uuid !== undefined &&
        pending.has(message.uuid)
      );
    },
    close(error: unknown) {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    },
  };
}
