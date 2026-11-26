import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ActiveExecution,
  PendingQuestion,
  SessionDependencies,
} from "./execution-types.d.mts";

function delegatedPermission({
  threadId,
  turnId,
  name,
  input,
  signal,
  questions,
  broadcast,
}: {
  threadId: string;
  turnId?: string;
  name: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  questions: Map<string, PendingQuestion>;
  broadcast: SessionDependencies["broadcast"];
}): Promise<PermissionResult> {
  const id = randomUUID();
  const question = {
    id,
    method: "lan/agy/permission",
    params: {
      threadId,
      turnId,
      reason: name,
      scope: input,
      options: [
        { optionId: "allow", name: "允许一次", kind: "allow_once" },
        { optionId: "deny", name: "拒绝", kind: "reject_once" },
      ],
    },
  };
  return new Promise((resolve) => {
    const abort = () => {
      questions.delete(id);
      resolve({ behavior: "deny", message: "执行轮次已停止" });
    };
    questions.set(id, {
      threadId,
      permission: true,
      input,
      question,
      resolve(result) {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else broadcast(question);
  });
}

export function delegationToolOptions(scope?: "research" | "implementation") {
  return {
    allowDangerouslySkipPermissions: !scope,
    ...(scope === "research" && {
      tools: ["Read", "Glob", "Grep", "AskUserQuestion"],
      disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "Agent"],
    }),
  };
}

export function createPermissionCheck({
  current,
  threadId,
  questions,
  broadcast,
}: {
  current: () => ActiveExecution | undefined | null;
  threadId: string;
  questions: Map<string, PendingQuestion>;
  broadcast: SessionDependencies["broadcast"];
}): CanUseTool {
  return async (name, input, { signal }) => {
    const active = current();
    if (active?.queued.delegation === "implementation")
      return delegatedPermission({
        threadId,
        turnId: active.turn.id,
        name,
        input,
        signal,
        questions,
        broadcast,
      });
    if (active?.turn.mode === "plan" || active?.queued.review)
      return {
        behavior: "deny",
        message: "当前任务处于只读模式，请使用读取和调查工具。",
      };
    return { behavior: "allow", updatedInput: input };
  };
}
