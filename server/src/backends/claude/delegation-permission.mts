import { readPromptSections } from "../../prompts.mjs";
import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ActiveExecution,
  PendingQuestion,
  QueuedExecution,
  SessionDependencies,
} from "./execution-types.d.mts";

const localExecutionTools = ["Bash", "Write", "Edit", "NotebookEdit", "Agent"];

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

export function executionPermissionMode(
  queued: QueuedExecution,
): PermissionMode {
  if (queued.mode === "plan" || queued.review) return "plan";
  return queued.delegation ? "default" : "bypassPermissions";
}

export function delegationToolOptions(
  scope?: "research" | "implementation",
): Pick<
  Options,
  "allowDangerouslySkipPermissions" | "tools" | "disallowedTools"
> {
  return {
    allowDangerouslySkipPermissions: !scope,
    ...(scope === "research" && {
      tools: ["Read", "Glob", "Grep", "AskUserQuestion"],
      disallowedTools: localExecutionTools,
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
        message: readPromptSections("backends/claude/execution.md")(
          "readOnlyTool",
        ),
      };
    return { behavior: "allow", updatedInput: input };
  };
}
