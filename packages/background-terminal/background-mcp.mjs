import { createInterface } from "node:readline";
import {
  BACKGROUND_INSTRUCTIONS,
  BACKGROUND_TOOLS,
  validateBackgroundArguments,
} from "./background-protocol.mjs";
import { taskRequest } from "./client.mjs";

const directory = process.argv[3];
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
    if (request?.id === undefined) continue;
    let result;
    if (request.method === "initialize") {
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "Codex 后台终端", version: "2" },
        instructions: BACKGROUND_INSTRUCTIONS,
      };
    } else if (request.method === "ping") result = {};
    else if (request.method === "tools/list")
      result = { tools: BACKGROUND_TOOLS };
    else if (
      ["resources/list", "resources/templates/list", "prompts/list"].includes(
        request.method,
      )
    )
      result = { resources: [], resourceTemplates: [], prompts: [] };
    else if (request.method === "tools/call") {
      try {
        const { name, arguments: args = {}, _meta: meta = {} } = request.params;
        validateBackgroundArguments(name, args);
        if (typeof meta.threadId !== "string" || !meta.threadId)
          throw new Error("后台工具需要所属 Codex 对话");

        const value = await taskRequest(directory, "tool", {
          name,
          args,
          threadId: meta.threadId,
          callId: meta.callId,
          expectedUpstream: process.env.CLAUDEX_BACKGROUND_UPSTREAM,
        });
        result = {
          content: [{ type: "text", text: JSON.stringify(value) }],
          isError: false,
        };
      } catch (error) {
        result = {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    } else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "未知 MCP 方法" },
        }) + "\n",
      );
      continue;
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request?.id ?? null,
        error: { code: request ? -32602 : -32700, message: error.message },
      }) + "\n",
    );
  }
}
