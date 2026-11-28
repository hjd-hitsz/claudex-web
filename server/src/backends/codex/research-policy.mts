import type { NativeParams } from "./native-protocol.d.mts";
import {
  backgroundDisabled,
  readOnlyThread,
  readOnlyTurn,
} from "../../../../packages/background-terminal/thread-policy.mjs";

const researchHistoryMethods = new Set([
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/items/read",
  "thread/unsubscribe",
  "thread/backgroundTerminals/list",
  "thread/backgroundTasks/list",
  "thread/backgroundTasks/read",
]);

export function checkWebResearchAccess(
  method: string,
  params: NativeParams,
  research: boolean,
) {
  if (
    ((method === "thread/resume" || method === "thread/fork") && params.path) ||
    (method === "thread/resume" && params.history != null)
  )
    throw new Error("请使用会话 ID 指定 Codex 会话。");
  if (
    research &&
    method !== "thread/resume" &&
    !researchHistoryMethods.has(method)
  )
    throw new Error("此 Codex 研究会话由委派任务只读执行。");
}

export function researchSessionParams(
  method: string,
  params: NativeParams,
  web: boolean,
): NativeParams {
  if (method === "turn/start") {
    const { sandbox: _sandbox, permissions: _permissions, ...turn } = params;
    return { ...turn, ...readOnlyTurn };
  }
  const { threadId, excludeTurns, initialTurnsPage } = params;
  const {
    permissions: _permissions,
    sandboxPolicy: _sandboxPolicy,
    ...session
  } = web ? { threadId, excludeTurns, initialTurnsPage } : params;
  return {
    ...session,
    ...readOnlyThread,
    config: { ...session.config, ...backgroundDisabled },
  };
}
