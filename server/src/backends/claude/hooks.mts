import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { snapshotToolWorkspace } from "./git-tool-changes.mjs";
import { readProjectInstructions } from "./project-instructions.mjs";
import type {
  HookCallback,
  Options,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentInput,
  AskUserQuestionInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import type {
  PendingQuestion,
  SaveSession,
  SessionDependencies,
  SessionRecord,
} from "./execution-types.d.mts";

async function contents(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function patch(before: string, after: string) {
  const lines = (text: string, prefix: string) => {
    const rows = text.split("\n");
    if (rows.at(-1) === "") rows.pop();
    return (
      rows.map((line) => prefix + line + "\n").join("") +
      (text && !text.endsWith("\n") ? "\\ No newline at end of file\n" : "")
    );
  };
  const count = (text: string) =>
    text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
  return `--- a/file\n+++ b/file\n@@ -${before ? 1 : 0},${count(before)} +${after ? 1 : 0},${count(after)} @@\n${lines(before, "-")}${lines(after, "+")}`;
}
type HookOptions = {
  threadId: string;
  context: () => { turnId: string; readOnly?: boolean };
  save: SaveSession;
  broadcast: SessionDependencies["broadcast"];
  questions: Map<string, PendingQuestion>;
  goalBeforeTool: HookCallback;
  onPromptFailure: (error: unknown) => void;
};

type Workspace = NonNullable<Awaited<ReturnType<typeof snapshotToolWorkspace>>>;
type Snapshot =
  { workspace: Workspace } | { path: string; before: string | null };

export function createRunHooks({
  threadId,
  context,
  save,
  broadcast,
  questions,
  goalBeforeTool,
  onPromptFailure,
}: HookOptions): NonNullable<Options["hooks"]> {
  const snapshots = new Map<string, Snapshot>();
  async function record(
    item: { id: string; type: string } & Record<string, unknown>,
  ) {
    const { turnId } = context();
    await save(threadId, (s) => ({
      ...s,
      extraItems: { ...s.extraItems, [item.id]: item },
    }));
    broadcast({ method: "item/completed", params: { threadId, turnId, item } });
  }
  const before: HookCallback = async (input, _toolId, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const { turnId } = context();
    if (input.tool_name === "Bash" && !context().readOnly) {
      const workspace = await snapshotToolWorkspace(input.cwd);
      if (workspace) snapshots.set(input.tool_use_id, { workspace });
    }
    if (input.tool_name === "Agent") {
      const agent = input.tool_input as AgentInput;
      await save(threadId, (s) => ({
        ...s,
        agentCalls: {
          ...s.agentCalls,
          [input.tool_use_id]: {
            toolUseId: input.tool_use_id,
            initialTask: agent.prompt,
            name: agent.name || agent.description,
            agentType: agent.subagent_type,
          },
        },
      }));
    }
    if (input.tool_name === "AskUserQuestion") {
      const id = randomUUID(),
        value = input.tool_input as AskUserQuestionInput;
      const question = {
        id,
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: input.tool_use_id,
          questions: value.questions.map((q, i) => ({
            ...q,
            id: String(i),
            isOther: true,
            isSecret: false,
          })),
        },
      };
      const answer = await new Promise<PermissionResult>((resolve) => {
        const abort = () => {
          questions.delete(id);
          resolve({ behavior: "deny", message: "提问已取消" });
        };
        questions.set(id, {
          threadId,
          input: value,
          question,
          resolve: (result) => {
            signal.removeEventListener("abort", abort);
            resolve(result);
          },
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else broadcast(question);
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: answer.behavior === "allow" ? "allow" : "deny",
          updatedInput:
            answer.behavior === "allow" ? answer.updatedInput : undefined,
          permissionDecisionReason:
            answer.behavior === "deny" ? answer.message : undefined,
        },
      };
    }
    const tool = input.tool_input as {
      file_path?: string;
      notebook_path?: string;
    };
    const path = tool.file_path || tool.notebook_path;
    if (typeof path === "string" && path)
      snapshots.set(input.tool_use_id, {
        path: resolve(input.cwd, path),
        before: await contents(resolve(input.cwd, path)),
      });
    return {};
  };
  const after: HookCallback = async (input) => {
    if (
      input.hook_event_name !== "PostToolUse" &&
      input.hook_event_name !== "PostToolUseFailure"
    )
      return {};
    const { turnId } = context();
    const previous = snapshots.get(input.tool_use_id);
    if (!previous) return {};
    snapshots.delete(input.tool_use_id);
    if ("workspace" in previous) {
      try {
        const changes = await previous.workspace.changes();
        if (changes.length)
          await record({
            id: `file-${input.tool_use_id}`,
            turnId,
            type: "fileChange",
            status: "completed",
            changes,
          });
      } finally {
        await previous.workspace.close();
      }
      return {};
    }
    const after = await contents(previous.path);
    if (previous.before === after || after === null) return {};
    await record({
      id: `file-${input.tool_use_id}`,
      turnId,
      type: "fileChange",
      status: "completed",
      changes: [
        {
          path: previous.path,
          kind: { type: previous.before === null ? "add" : "update" },
          diff:
            previous.before === null ? after : patch(previous.before, after),
        },
      ],
    });
    return {};
  };
  const agent: HookCallback = async (input) => {
    if (
      input.hook_event_name !== "SubagentStart" &&
      input.hook_event_name !== "SubagentStop"
    )
      return {};
    const { turnId } = context();
    const id = `agent/${threadId}/${input.agent_id}`;
    let details: NonNullable<SessionRecord["agents"]>[string] | undefined;
    await save(threadId, (s) => {
      details = {
        ...s.agents?.[id],
        agentId: input.agent_id,
        name: s.agents?.[id]?.name || input.agent_type,
        agentType: input.agent_type,
        parentNativeId: input.session_id,
      };
      return { ...s, agents: { ...s.agents, [id]: details } };
    });
    await record({
      id: `agent-${input.agent_id}`,
      turnId,
      type: "subAgentActivity",
      kind: input.hook_event_name === "SubagentStart" ? "started" : "completed",
      agentThreadId: id,
      agentPath: details?.name,
      prompt: details?.initialTask,
    });
    return {};
  };
  const instructions: HookCallback = async (input) => {
    try {
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: await readProjectInstructions(input.cwd),
        },
      };
    } catch (error) {
      onPromptFailure(error);
      throw error;
    }
  };
  return {
    UserPromptSubmit: [
      {
        onFailure: "block",
        hooks: [instructions],
      },
    ],
    PreToolUse: [
      { hooks: [goalBeforeTool] },
      {
        matcher: "AskUserQuestion|Write|Edit|NotebookEdit|Agent|Bash",
        hooks: [before],
        timeout: 86400,
      },
    ],
    PostToolUse: [{ matcher: "Write|Edit|NotebookEdit|Bash", hooks: [after] }],
    PostToolUseFailure: [
      { matcher: "Write|Edit|NotebookEdit|Bash", hooks: [after] },
    ],
    SubagentStart: [{ hooks: [agent] }],
    SubagentStop: [{ hooks: [agent] }],
    SessionEnd: [
      {
        hooks: [
          async () => {
            await Promise.all(
              [...snapshots.values()].map((snapshot) =>
                "workspace" in snapshot
                  ? snapshot.workspace.close()
                  : undefined,
              ),
            );
            snapshots.clear();
            return {};
          },
        ],
      },
    ],
  };
}
