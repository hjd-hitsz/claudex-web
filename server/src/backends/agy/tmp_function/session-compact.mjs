// ACP 缺口：agy 1.5.18 的 session/compact 返回 -32601，秘书代理的命令
// 目录不包含 compact。session/prompt 中的 /compact 进入普通模型请求。
// 探测证据：默认代理写入原生检查点，自定义秘书代理、继承设置及以默认
// 代理续接同一会话均在原会话保留完整请求历史。
// 切换条件：ACP 能在保留秘书代理的前提下整理并发出已生效的检查点事件。
// 登记见 docs/future_plan.md#缺口登记。
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readPromptSections, renderPrompt } from "../../../prompts.mjs";
import { acpContent } from "../acp-events.mjs";
import { applyAcpSelection, updateAcpConfiguration } from "../acp-models.mjs";
import { visibleAgyItems, visibleAcpMessage } from "../acp-messages.mjs";
import { writePrivateFile } from "../../../private-file.mjs";
import { agyTokenUsage, countAgyCompactions } from "../context-usage.mjs";
import { nowSeconds } from "../session-store.mjs";

const prompts = readPromptSections("secretary/compaction.md");
const compactorName = "claudex-compactor";
const compactorAgent =
  prompts("agent").split("\n").slice(1, -1).join("\n") + "\n";
const compactorHooks = {
  "claudex-compactor": {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `printf '%s\\n' '{"decision":"deny","reason":"Claudex compactor has no tool access"}'`,
          },
        ],
      },
    ],
  },
};

export async function installAgyCompactor(launchDir) {
  const directory = join(launchDir, ".agents", "agents", compactorName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writePrivateFile(join(directory, "agent.md"), compactorAgent);
}

export function compactedContext(checkpoint) {
  return {
    type: "text",
    text: renderPrompt(prompts("continue"), { summary: checkpoint.summary }),
  };
}

function compilation(session) {
  const previous = session.contextCheckpoint;
  const boundary = session.turns.findIndex(
    ({ id }) => id === previous?.throughTurnId,
  );
  return JSON.stringify({
    checkpoint: previous?.summary,
    turns: session.turns.slice(boundary + 1).map((turn) => ({
      status: turn.status,
      items: visibleAgyItems(turn.items).flatMap((item) => {
        if (item.type === "userMessage")
          return [
            {
              type: item.type,
              content: item.content.map(({ type, text, path }) => ({
                type,
                text,
                path,
              })),
            },
          ];
        if (item.type === "agentMessage")
          return [{ type: item.type, text: item.text }];
        if (item.type === "mcpToolCall")
          return [
            {
              type: item.type,
              tool: item.tool,
              status: item.status,
              result: item.result,
            },
          ];
        if (item.type === "fileChange")
          return [
            {
              type: item.type,
              changes: item.changes.map(({ path, kind }) => ({ path, kind })),
            },
          ];
        return [];
      }),
    })),
  });
}

async function summarize(
  session,
  { activeSignal, launch, launchDir, onUsage },
) {
  const cwd = await mkdtemp(join(launchDir, "compact-"));
  let client;
  let nativeId;
  let summary = "";
  let unexpectedTool = false;
  const cancel = () => client?.close();
  try {
    activeSignal.addEventListener("abort", cancel, { once: true });
    activeSignal.throwIfAborted();
    // agy 1.5.18 暴露内置 manage_task，临时工作区的钩子负责拦截。
    await writePrivateFile(
      join(cwd, ".agents", "hooks.json"),
      JSON.stringify(compactorHooks),
    );
    activeSignal.throwIfAborted();
    client = await launch(
      compactorName,
      (method, params) => {
        if (method !== "session/update" || params.sessionId !== nativeId)
          return;
        const { update } = params;
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        )
          summary += update.content.text;
        if (["tool_call", "tool_call_update"].includes(update.sessionUpdate))
          unexpectedTool = true;
      },
      activeSignal,
    );
    const response = await client.call("session/new", { cwd, mcpServers: [] });
    nativeId = response.sessionId;
    const entry = { client, nativeId, config: {} };
    updateAcpConfiguration(entry, response);
    await applyAcpSelection(entry, { preserveMode: true }, session);
    const latestUser = session.turns
      .flatMap(({ items }) => items)
      .findLast(({ type }) => type === "userMessage");
    const attachments =
      latestUser?.content?.filter(({ type }) => type === "image") || [];
    const result = await client.call(
      "session/prompt",
      {
        sessionId: nativeId,
        prompt: [
          {
            type: "text",
            text: renderPrompt(prompts("summarize"), {
              history: compilation(session),
            }),
          },
          ...acpContent(attachments),
        ],
      },
      0,
    );
    onUsage(result.usage);
    if (result.stopReason === "end_turn" && !unexpectedTool) {
      const text = visibleAcpMessage(summary).trim();
      try {
        const value = JSON.parse(
          text.replace(/^```json\s*([\s\S]*?)\s*```$/i, "$1"),
        )?.summary;
        if (typeof value === "string" && value.trim()) return value.trim();
      } catch {
        // 非结构化输出可能是 ACP 投影的模型错误，不能用于续接。
      }
    }
    throw new Error("agy 未生成可供续接的整理摘要");
  } finally {
    activeSignal.removeEventListener("abort", cancel);
    client?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function createNative(session, signal, launch, readRole) {
  const client = await launch(undefined, undefined, signal);
  try {
    const role = await readRole();
    const response = await client.call("session/new", {
      cwd: session.cwd,
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: role } } },
    });
    if (!response.sessionId) throw new Error("agy 未创建续接会话");
    await client.call("session/close", { sessionId: response.sessionId });
    return response.sessionId;
  } finally {
    client.close();
  }
}

export function createAgySessionCompaction({
  store,
  active,
  compactions,
  spawn,
  initialize,
  launchDir,
  readRole,
  discard,
  emit,
}) {
  async function launch(agent, onUpdate, signal) {
    const client = spawn(
      onUpdate,
      () => {
        throw new Error("整理期间无法调用工作区工具");
      },
      undefined,
      agent,
    );
    try {
      await initialize(client);
      signal.throwIfAborted();
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  return function compact(session) {
    const id = randomUUID();
    const threadId = session.id;
    const turn = {
      id,
      turnNumber: session.turns.length + 1,
      status: "inProgress",
      startedAt: nowSeconds(),
      items: [],
    };
    const controller = new AbortController();
    const done = Promise.withResolvers();
    const activity = {
      session,
      turn,
      controller,
      done: done.promise,
      input: { compaction: true },
    };
    active.set(threadId, activity);
    const notify = (method, params) =>
      emit({ method, params: { threadId, ...params } });
    const tracking = compactions.track(activity, notify);
    const completion = (async () => {
      let candidate;
      try {
        await store.change((data) => {
          store.session(data, threadId).turns.push({
            ...turn,
            compaction: compactions.entries.get(threadId),
          });
        });
        notify("turn/started", { turn });
        const summary = await summarize(session, {
          activeSignal: controller.signal,
          launch,
          launchDir: launchDir(),
          onUsage: (usage) => (activity.promptUsage = usage),
        });
        controller.signal.throwIfAborted();
        candidate = {
          id: await createNative(session, controller.signal, launch, readRole),
          checkpoint: {
            summary,
            throughTurnId: session.turns.at(-1)?.id,
            pending: true,
          },
        };
        controller.signal.throwIfAborted();
        turn.status = "completed";
      } catch (error) {
        turn.status = controller.signal.aborted ? "interrupted" : "failed";
        if (turn.status === "failed") turn.error = { message: error.message };
        candidate = undefined;
      }
      turn.completedAt = nowSeconds();
      const usage = await store.change((data) => {
        const saved = store.session(data, threadId);
        if (
          candidate &&
          (controller.signal.aborted || saved.nativeId !== session.nativeId)
        ) {
          turn.status = "interrupted";
          candidate = undefined;
        }
        if (candidate) {
          saved.previousNativeId = saved.nativeId;
          saved.nativeId = candidate.id;
          saved.contextCheckpoint = candidate.checkpoint;
          delete saved.nativeContextPending;
          activity.compactionApplied = true;
        }
        tracking.finish();
        turn.tokenUsage = agyTokenUsage(activity);
        saved.tokenUsage = turn.tokenUsage;
        const index = saved.turns.findIndex((entry) => entry.id === id);
        if (index < 0) saved.turns.push(turn);
        else saved.turns[index] = turn;
        saved.updatedAt = turn.completedAt;
        return {
          tokenUsage: saved.tokenUsage,
          ...(turn.compaction?.status === "completed" && {
            compactCount: countAgyCompactions(saved.turns),
          }),
        };
      });
      if (candidate) discard(threadId);
      notify("thread/tokenUsage/updated", { turnId: id, ...usage });
      tracking.publish();
      for (const item of turn.items)
        notify("item/completed", { turnId: id, item });
      notify("turn/completed", { turn });
    })()
      .catch((error) => {
        activity.compactionApplied = false;
        turn.items.length = 0;
        turn.status = "failed";
        turn.error = { message: error.message };
        tracking.finish();
        tracking.publish();
        notify("turn/completed", { turn });
      })
      .finally(() => {
        active.delete(threadId);
        done.resolve();
      });
    return { compaction: compactions.entries.get(threadId), completion };
  };
}
