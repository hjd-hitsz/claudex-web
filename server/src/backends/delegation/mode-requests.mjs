import { isSecretarySession } from "./session-role.mjs";
import { resourceTarget } from "../../../../shared/backend-identity.mjs";

import { guardedSecretaryOperations } from "../../../../shared/secretary-upgrade.mjs";
import { claudeSecretaryUpgradeRequired } from "../claude/secretary-policy.mjs";

export function delegationModeRequests(modes, enabled) {
  const supported = (backend) => enabled && backend.id !== "agy";

  async function forward(backend, method, params) {
    const { delegationMode, ...forwarded } = params || {};
    let selectedMode;
    if (
      backend.id === "codex" &&
      params?.threadId &&
      guardedSecretaryOperations.has(method)
    ) {
      const secretary = await modes.codexEnabledForResume(
        backend,
        params.threadId,
      );
      if (method === "thread/fork") selectedMode = secretary;
    }
    if (supported(backend)) {
      if (method === "thread/start")
        selectedMode = isSecretarySession(backend.id, delegationMode);
    }
    if (selectedMode !== undefined) forwarded.delegationMode = selectedMode;
    return { forwarded, selectedMode };
  }

  async function set(entry, params, call) {
    const { backend } = entry;
    const { threadId, delegationMode } = params;
    if (!supported(backend) || !threadId || typeof delegationMode !== "boolean")
      throw new Error("委派模式需要有效对话和开关状态。");
    if (delegationMode) {
      const continuation = await call(
        entry,
        "lan/delegation/secretary/continue",
        params,
      );
      const { nativeId: id } = resourceTarget(
        continuation.thread.id,
        backend.id,
      );
      await modes.save(backend, id, true, true);
      return {
        ...continuation,
        delegationMode: true,
        thread: {
          ...continuation.thread,
          model: continuation.thread.model || continuation.model,
          delegationMode: true,
        },
      };
    }
    if (backend.id === "claude")
      await call(entry, "lan/delegation/mode/set", params);
    await modes.save(backend, threadId, delegationMode);
    return { delegationMode };
  }

  async function project(backend, method, result, selected) {
    if (!supported(backend) || !result?.thread?.id) return result;
    const creating = method === "thread/start" || method === "thread/fork";
    if (!creating && method !== "thread/resume" && method !== "thread/read")
      return result;
    const threadId = result.thread.id;
    const delegationMode =
      backend.id === "claude" && typeof result.delegationMode === "boolean"
        ? result.delegationMode
        : creating
          ? (result.thread.delegationMode ?? selected === true)
          : await modes.enabled(backend, threadId);
    if (creating) await modes.save(backend, threadId, delegationMode, true);
    const secretaryContinuationRequired =
      backend.id === "claude"
        ? (result.thread.secretaryContinuationRequired ??
          claudeSecretaryUpgradeRequired(result.thread, delegationMode))
        : delegationMode &&
          !creating &&
          (await modes.status(backend, threadId)) === "upgrade";
    return {
      ...result,
      delegationMode,
      thread: {
        ...result.thread,
        delegationMode,
        secretaryContinuationRequired,
      },
    };
  }

  return { forward, set, project };
}
