import { request } from "node:http";

export function callConversationGateway(
  { socketPath, runtimeId, token },
  { threadId, turnId, name, args, callId },
) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ threadId, turnId, name, args, callId });
    const connection = request(
      {
        socketPath,
        path: "/conversation-tool",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-claudex-runtime": runtimeId,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      async (response) => {
        try {
          let text = "";
          response.setEncoding("utf8");
          for await (const chunk of response) text += chunk;
          const reply = JSON.parse(text);
          if (response.statusCode !== 200) throw new Error(reply.error);
          resolve(reply.result);
        } catch (error) {
          reject(error);
        }
      },
    );
    connection.setTimeout(30000, () =>
      connection.destroy(new Error("等待会话管理器响应超时")),
    );
    connection.on("error", reject);
    connection.end(body);
  });
}
