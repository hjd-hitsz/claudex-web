import { readPromptSections } from "../../prompts.mjs";
import { createInterface } from "node:readline";
import {
  delegationStepTool,
  delegationStepToolName,
} from "../../conversation-manager/tools.mjs";
import { connectIpc } from "./worker-ipc.mjs";

const descriptions = readPromptSections("delegation/workflow.md");

const [socket, token] = process.argv.slice(2);
const connection = await connectIpc(socket);
function reply(packet, written) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n",
    written,
  );
}
function tool(backend) {
  if (backend === delegationStepToolName)
    return { ...delegationStepTool, _meta: { "antigravity/alwaysLoad": true } };
  return {
    name: "ask_" + backend,
    description: descriptions(backend),
    inputSchema: {
      type: "object",
      required: ["request", "request_id"],
      additionalProperties: false,
      properties: {
        request: {
          type: "string",
          description: descriptions("request"),
        },
        request_id: {
          type: "string",
          description: descriptions("requestId"),
        },
        task_id: {
          type: "string",
          description: descriptions("taskId"),
        },
        scope: {
          type: "string",
          enum: ["research", "implementation"],
          description: descriptions("scope"),
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
