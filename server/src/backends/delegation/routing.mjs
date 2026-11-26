import { mapResult } from "../identity-mapping.mjs";
import {
  agyHistoryMethods,
  isDelegationThread,
} from "./delegation-history.mjs";

export function delegationRequest(delegation, method, params, target) {
  if (method === "lan/delegation/tasks")
    return delegation.tasks(params.threadId);
  if (method === "lan/delegation/respond")
    return delegation.respond({
      id: params.requestId,
      threadId: params.threadId,
      result: params.result,
      error: params.error,
    });
  if (method === "lan/delegation/cancel")
    return delegation.cancel(params.threadId, params.taskId);
  if (
    target.backendId !== "agy" &&
    isDelegationThread(target.nativeId) &&
    (agyHistoryMethods.has(method) || method === "lan/agents/messages")
  )
    return delegation
      .history(method, { ...params, threadId: target.nativeId })
      .then((result) => mapResult(result, target.backendId, method));
}
