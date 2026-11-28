import { createBackgroundSecretaryLookup } from "./delegation-records.mjs";
import { secretaryUpgradeRequired } from "./secretary-history-policy.mjs";
import { secretaryProjectParams } from "./project-instructions.mjs";

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
export function createBackgroundResume(directory) {
  const secretaryStatus = createBackgroundSecretaryLookup(directory);
  return async (call, params, { cwd, research } = {}) => {
    const status = research
      ? "ordinary"
      : await secretaryStatus(params.threadId);
    if (status === "upgrade") throw new Error(secretaryUpgradeRequired);
    if (status === "secretary") {
      cwd ??= (
        await call("thread/read", {
          threadId: params.threadId,
          includeTurns: false,
        })
      ).thread.cwd;
      params = await secretaryProjectParams(params, cwd);
    }
    return call("thread/resume", params);
  };
}
