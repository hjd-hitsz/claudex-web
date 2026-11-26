import { fileURLToPath } from "node:url";
import {
  delegationStepToolName,
  delegationToolName,
} from "../../conversation-manager/tools.mjs";
import { threadMethods } from "./methods.mjs";

export const codexConversationMcpName = "claudex_conversations";

export function codexConversationToolParams(method, params, endpoint) {
  if (!endpoint || !threadMethods.has(method)) return params;
  return {
    ...params,
    config: {
      ...params.config,
      [`mcp_servers.${codexConversationMcpName}`]: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./conversation-mcp.mjs", import.meta.url)),
        ],
        env: { CLAUDEX_CONVERSATION_ENDPOINT: JSON.stringify(endpoint) },
        enabled: true,
        // The bridge checks the active mode token for submissions and task ownership for reads.
        tools: {
          [delegationToolName]: { approval_mode: "approve" },
          [delegationStepToolName]: { approval_mode: "approve" },
        },
        startup_timeout_sec: 15,
      },
    },
  };
}
