import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { InputPart, SessionRecord } from "./execution-types.d.mts";
import type { ConversationInput } from "./conversation-protocol.d.mts";

type Content = Exclude<SDKUserMessage["message"]["content"], string>;
type ImageSource = Extract<Content[number], { type: "image" }>["source"];
type ImageMediaType = Extract<ImageSource, { type: "base64" }>["media_type"];

export function inputMessage(input: readonly InputPart[]): Content {
  return input.map((part) => {
    if (part.type === "text" && typeof part.text === "string")
      return { type: "text", text: part.text };
    if (part.type === "image") {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(part.url ?? "");
      if (!match) throw new Error("Claude 图片需要内嵌图片数据");
      return {
        type: "image",
        // MIME 随原始图片提交，所选供应商负责最终的格式支持判定。
        source: {
          type: "base64",
          media_type: match[1] as ImageMediaType,
          data: match[2],
        },
      };
    }
    if (part.type === "skill")
      throw new Error("请移除旧技能附件，并从技能菜单重新选择原生命令。");
    throw new Error(`Claude 暂不支持此附件类型：${part.type}`);
  });
}

export function userPrompt(
  session: Pick<SessionRecord, "id" | "nativeSessionId">,
  queued: {
    id: NonNullable<SDKUserMessage["uuid"]>;
    input: readonly InputPart[];
    peer?: ConversationInput;
  },
  priority?: SDKUserMessage["priority"],
): SDKUserMessage {
  return {
    type: "user",
    uuid: queued.id,
    session_id: session.nativeSessionId || session.id,
    parent_tool_use_id: null,
    message: { role: "user", content: inputMessage(queued.input) },
    ...(queued.peer && {
      client_composed: true,
      origin: {
        kind: "peer",
        from: queued.peer.from.threadId,
        name: queued.peer.from.title,
      },
    }),
    ...(priority && { priority }),
  };
}
