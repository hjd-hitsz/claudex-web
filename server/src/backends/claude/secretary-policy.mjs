import { randomUUID } from "node:crypto";
import { secretaryUpgradeRequired } from "../../../../shared/secretary-upgrade.mjs";

export const secretaryHistoryVersion = 1;

export async function claudeSecretaryMode(session, readLegacy) {
  return session.delegationMode ?? readLegacy(session.id);
}

export function claudeSecretaryUpgradeRequired(session, delegationMode) {
  return (
    delegationMode === true &&
    session.secretaryHistoryVersion !== secretaryHistoryVersion
  );
}

export async function assertClaudeSecretaryHistory(
  session,
  readLegacy,
  queued,
) {
  const mode = await claudeSecretaryMode(session, readLegacy);
  if (claudeSecretaryUpgradeRequired(session, mode || queued?.delegationMode))
    throw new Error(secretaryUpgradeRequired);
  return queued?.delegationMode ?? mode;
}

export function claudeSecretaryGuard(readLegacy) {
  /** @type {(session: import("./execution-types.d.mts").SessionRecord, queued?: import("./execution-types.d.mts").QueuedInput) => Promise<boolean>} */
  const check = (session, queued) =>
    assertClaudeSecretaryHistory(session, readLegacy, queued);
  return check;
}

export async function verifyPendingClaudeSecretary(
  outdated,
  threadId,
  request,
) {
  if (!outdated || typeof threadId !== "string") return;
  const reply = await request({
    kind: "rpc",
    message: {
      id: randomUUID(),
      method: "thread/read",
      params: { threadId },
    },
  });
  const thread = reply?.result?.thread;
  if (reply?.error || !thread)
    throw new Error(reply?.error?.message || "对话不存在");
  if (claudeSecretaryUpgradeRequired(thread, thread.delegationMode))
    throw new Error(secretaryUpgradeRequired);
}
