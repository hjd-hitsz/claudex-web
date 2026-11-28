export const readOnlyThread = {
  sandbox: "read-only",
  approvalPolicy: "never",
};

export const readOnlyTurn = {
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  approvalPolicy: "never",
};

export const backgroundDisabled = {
  "mcp_servers.claudex_background": {
    command: process.execPath,
    enabled: false,
  },
};

export function backgroundResumeParams(threadId, research) {
  return {
    threadId,
    excludeTurns: true,
    ...(research && { ...readOnlyThread, config: backgroundDisabled }),
  };
}
