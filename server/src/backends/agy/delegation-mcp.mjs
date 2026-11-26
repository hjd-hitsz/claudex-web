import { createInterface } from "node:readline";
import { connectIpc } from "./worker-ipc.mjs";

const [socket, token] = process.argv.slice(2);
const connection = await connectIpc(socket);
const descriptions = {
  codex:
    "Delegate engineering work to Codex. Send new requirements immediately with the original task_id, including while it is running. End the current turn after acceptance.",
  claude:
    "Delegate engineering work to Claude Code. Send new requirements immediately with the original task_id, including while it is running. End the current turn after acceptance.",
};
function reply(packet, written) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n",
    written,
  );
}
function tool(backend) {
  return {
    name: "ask_" + backend,
    description: descriptions[backend],
    inputSchema: {
      type: "object",
      required: ["request", "request_id"],
      additionalProperties: false,
      properties: {
        request: {
          type: "string",
          description: "Task or specific follow-up with acceptance criteria",
        },
        request_id: {
          type: "string",
          description: "Unique identifier. Reuse it if retrying this request.",
        },
        task_id: {
          type: "string",
          description:
            "Original task ID to continue in the same executor conversation. A running step is interrupted.",
        },
        scope: {
          type: "string",
          enum: ["research", "implementation"],
          description:
            "Use research for read-only work, including document preparation.",
        },
      },
    },
    _meta: { "antigravity/alwaysLoad": true },
  };
}
createInterface({ input: process.stdin })
  .on("line", async (line) => {
    const packet = JSON.parse(line);
    const { id, method, params } = packet;
    if (method === "notifications/roots/list_changed") {
      await connection.call("mcp/ready", { token }).catch(() => {});
      return;
    }
    if (id === undefined) return;
    try {
      if (method === "initialize")
        return reply({
          id,
          result: {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "claudex-delegation", version: "1" },
          },
        });
      if (method === "tools/list") {
        const available = await connection.call("mcp/list", { token });
        return reply({ id, result: { tools: available.map(tool) } }, () =>
          connection.call("mcp/ready", { token }).catch(() => {}),
        );
      }
      if (method === "tools/call") {
        const result = await connection.call("mcp/call", {
          token,
          tool: params.name,
          input: params.arguments,
        });
        return reply({
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          },
        });
      }
      reply({ id, error: { code: -32601, message: "Method not found" } });
    } catch (error) {
      if (method === "tools/call")
        reply({
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: error.message }],
          },
        });
      else reply({ id, error: { code: -32000, message: error.message } });
    }
  })
  .on("close", connection.close);

connection.socket.on("close", () => process.stdin.destroy());
