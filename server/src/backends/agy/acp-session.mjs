import { secretaryAgent } from "./secretary-prompts.mjs";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateFile } from "../../private-file.mjs";
import { createAcpClient } from "./acp-client.mjs";
import { applyAcpUpdate, flushAcpMessage } from "./acp-events.mjs";
import {
  acpConfiguration,
  applyAcpSelection,
  updateAcpConfiguration,
} from "./acp-models.mjs";
import { createAgyModelCatalogue } from "./model-catalogue.mjs";
import { resolveSourcePrompt } from "../delegation/settings.mjs";
import { nowSeconds } from "./session-store.mjs";
import { currentResultNotice } from "../delegation/delegation-store.mjs";
import { savedAgyAgent, secretaryName } from "./native-agent.mjs";
import { agyConversationContext } from "./acp-messages.mjs";
import { readPromptSections, renderPrompt } from "../../prompts.mjs";

const mcp = fileURLToPath(new URL("./delegation-mcp.mjs", import.meta.url));
const capable = (response, key) =>
  response.agentCapabilities?.sessionCapabilities?.[key];
const continuation = readPromptSections("delegation/workflow.md")(
  "secretaryContinuation",
);

export function createAcpSessions({
  store,
  getBackend,
  socket,
  execution,
  emit,
  readAgent = savedAgyAgent,
}) {
  const entries = new Map();
  const tokens = new Map();
  const active = new Map();
  const pending = new Map();
  const catalogue = createAgyModelCatalogue({
    read: readCatalogue,
    publish: ({ models, model, effort }) =>
      emit({ method: "lan/agy/models", params: { models, model, effort } }),
  });
  let catalogueClient;
  let path;
  let startup;
  let connectionError = "";
  const launchDir = () => join(getBackend().stateDir, "launch");
  const readRole = () => resolveSourcePrompt(getBackend(), "agy");

  function spawn(onUpdate, onRequest, onExit) {
    const { proxy } = getBackend();
    return createAcpClient({
      executable: path,
      cwd: launchDir(),
      proxy,
      onUpdate,
      onRequest,
      onExit,
    });
  }
  async function initialize(client) {
    const result = await client.call("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "Claudex Web", version: "1" },
      clientCapabilities: { session: { compaction: {} } },
    });
    if (
      result.protocolVersion !== 1 ||
      !result.agentCapabilities?.loadSession ||
      !capable(result, "resume") ||
      !capable(result, "close") ||
      !(
        result.agentCapabilities?._meta?.antigravity ||
        result._meta?.antigravity
      )?.systemPrompt?.append
    )
      throw new Error(
        "当前 agy ACP 版本缺少秘书会话所需的加载、续接或系统指令接口",
      );
    return result;
  }
  async function connect(executable) {
    path = executable;
    const destination = join(
      launchDir(),
      ".agents",
      "agents",
      secretaryName,
      "agent.md",
    );
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writePrivateFile(destination, secretaryAgent);
    const client = spawn();
    try {
      startup = await initialize(client);
      connectionError = "";
      catalogue.get().catch(() => {});
    } catch (error) {
      connectionError = error.message;
      throw error;
    } finally {
      client.close();
    }
    return startup.agentInfo?.version;
  }
  async function readCatalogue() {
    if (!startup) throw new Error(connectionError || "agy ACP 尚未就绪");
    const client = spawn();
    catalogueClient = client;
    try {
      await initialize(client);
      const role = await readRole();
      const session = await client.call("session/new", {
        cwd: launchDir(),
        mcpServers: [],
        _meta: { antigravity: { systemPrompt: { append: role } } },
      });
      const result = acpConfiguration(session);
      await client.call("session/close", { sessionId: session.sessionId });
      return result;
    } finally {
      client.close();
      catalogueClient = undefined;
    }
  }
  function discard(id, entry) {
    if (entries.get(id) !== entry) return;
    entries.delete(id);
    tokens.delete(entry.token);
    clearTimeout(entry.idle);
    entry.client.close();
  }
  function idle(id, entry) {
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => discard(id, entry), 300000);
    entry.idle.unref();
  }
  const agent = (nativeId) =>
    startup?.agentInfo?.name === "Antigravity ACP Server"
      ? readAgent(nativeId)
      : undefined;

  async function open(session, role) {
    const current = entries.get(session.id);
    if (current) {
      clearTimeout(current.idle);
      const entry = await current.open;
      if (role === undefined || entry.role === role) return entry;
      discard(session.id, entry);
      return open({ ...session, nativeId: entry.nativeId }, role);
    }
    const entry = {
      id: session.id,
      token: randomUUID(),
      nativeId: session.nativeId,
      created: !session.nativeId,
      config: {},
      options: [],
    };
    tokens.set(entry.token, entry);
    entries.set(session.id, entry);
    const notify = (method, params) =>
      emit({ method, params: { threadId: session.id, ...params } });
    entry.client = spawn(
      (method, p) => {
        if (method !== "session/update" || p.sessionId !== entry.nativeId)
          return;
        if (p.update.configOptions) updateAcpConfiguration(entry, p.update);
        if (p.update.sessionUpdate === "available_commands_update")
          entry.commands = p.update.availableCommands || [];
        const activity = active.get(session.id);
        if (activity?.submitted) {
          if (p.update.sessionUpdate === "session_info_update")
            activity.title = p.update.title;
          applyAcpUpdate(activity, p.update, notify);
        }
      },
      (method, params) => execution.acpRequest(entry, method, params),
      () => {
        if (entries.get(session.id) !== entry) return;
        entries.delete(session.id);
        tokens.delete(entry.token);
        clearTimeout(entry.idle);
      },
    );
    entry.open = (async () => {
      await initialize(entry.client);
      entry.role = role ?? (await readRole());
      const options = {
        cwd: session.cwd,
        ...(capable(startup, "additionalDirectories") && {
          additionalDirectories: [launchDir()],
        }),
        mcpServers: [
          {
            name: "claudex_delegation",
            command: process.execPath,
            args: [mcp, socket, entry.token],
            env: [],
            _meta: { antigravity: { forceAllToolsEager: true } },
          },
        ],
        _meta: {
          antigravity: {
            systemPrompt: { append: entry.role },
            eagerMcpServers: true,
          },
        },
      };
      const response = session.nativeId
        ? await entry.client.call("session/resume", {
            ...options,
            sessionId: session.nativeId,
          })
        : await entry.client.call("session/new", options);
      entry.nativeId = session.nativeId || response.sessionId;
      if (!entry.nativeId) throw new Error("agy 未返回原生会话 ID");
      updateAcpConfiguration(entry, response);
      idle(session.id, entry);
      return entry;
    })().catch((error) => {
      discard(session.id, entry);
      throw error;
    });
    return entry.open;
  }

  async function prepareSession(session, role, activity) {
    const saved = await agent(session.nativeId);
    const repair = saved !== undefined && saved !== secretaryName;
    if (repair) {
      const previous = entries.get(session.id);
      if (previous) discard(session.id, previous);
    }
    let entry = await open(
      repair ? { ...session, nativeId: undefined } : session,
      role,
    );
    clearTimeout(entry.idle);
    if (entry.created) {
      // agy exposes the newly registered session MCP tool declarations after resume.
      try {
        await execution.prepareMcp(entry, activity);
        await entry.client.call("session/close", { sessionId: entry.nativeId });
      } finally {
        discard(session.id, entry);
      }
      entry = await open({ ...session, nativeId: entry.nativeId }, role);
      clearTimeout(entry.idle);
      const nativeAgent = await agent(entry.nativeId);
      if (nativeAgent !== undefined && nativeAgent !== secretaryName) {
        discard(session.id, entry);
        throw new Error("Antigravity 未加载 Claudex 秘书角色，请重试当前消息");
      }
    }
    await execution.prepareMcp(entry, activity);
    return { entry, repair };
  }

  async function prompt(session, record, input, blocks) {
    if (active.has(session.id)) throw new Error("agy 会话已有正在执行的轮次");
    const turn = {
      id: record.id,
      status: "inProgress",
      startedAt: nowSeconds(),
      items: record.items,
    };
    const done = Promise.withResolvers();
    const activity = {
      turn,
      input,
      session,
      ready: false,
      done: done.promise,
      controller: new AbortController(),
    };
    let initialItemCount = 0;
    let ignored = false;
    active.set(session.id, activity);
    const notify = (method, params) =>
      emit({ method, params: { threadId: session.id, ...params } });
    try {
      const role = await readRole();
      const { entry, repair } = await prepareSession(session, role, activity);
      await applyAcpSelection(entry, input, session);
      let promptBlocks = input.userInput
        ? await execution.forwardingContext(session.id, blocks)
        : blocks;
      const contextPending =
        (repair || session.nativeContextPending) &&
        (input.userInput || input.notice);
      if (contextPending && session.turns.length)
        promptBlocks = [
          {
            type: "text",
            text: renderPrompt(continuation, {
              history: agyConversationContext(session.turns),
            }),
          },
          ...promptBlocks,
        ];
      const submitted = await store.change((data) => {
        if (activity.cancelled) return false;
        const notice = data.notices[record.noticeId];
        if (
          record.noticeId &&
          (notice?.status !== "queued" || !currentResultNotice(data, notice))
        )
          return false;
        const s = store.session(data, session.id);
        if (repair) {
          s.previousNativeId = session.nativeId;
          s.nativeContextPending = true;
        }
        s.nativeId = entry.nativeId;
        s.model = entry.config.model || s.model;
        s.effort = entry.config.effort || s.effort;
        s.turns.push(turn);
        if (record.noticeId) notice.status = "submitting";
        return true;
      });
      if (!submitted || activity.cancelled) {
        ignored = Boolean(record.noticeId && !submitted);
        turn.status = "interrupted";
        return { turn };
      }
      activity.ready = true;
      notify("turn/started", { turn });
      initialItemCount = turn.items.length;
      for (const item of turn.items)
        notify("item/completed", { turnId: turn.id, item });
      notify("thread/settings/updated", {
        threadSettings: {
          model: entry.config.model,
          reasoningEffort: entry.config.effort,
          collaborationMode: { mode: "default" },
        },
      });
      activity.submitted = true;
      const result = await entry.client.call(
        "session/prompt",
        { sessionId: entry.nativeId, prompt: promptBlocks },
        0,
      );
      activity.contextAccepted =
        contextPending && result.stopReason !== "cancelled";
      flushAcpMessage(activity, notify);
      const lastAction = turn.items.findLast(({ type }) =>
        ["agentMessage", "mcpToolCall", "fileChange"].includes(type),
      );
      if (lastAction?.type === "mcpToolCall" && lastAction.status === "failed")
        activity.error ||= `Antigravity 在工具「${lastAction.tool}」失败后结束了本轮。`;
      turn.status =
        activity.cancelled || result.stopReason === "cancelled"
          ? "interrupted"
          : activity.error
            ? "failed"
            : result.stopReason === "end_turn"
              ? "completed"
              : "failed";
      if (turn.status === "failed")
        turn.error = {
          message: activity.error || "agy 结束原因：" + result.stopReason,
        };
      if (record.noticeId) await execution.finishNotice(record.noticeId, turn);
    } catch (error) {
      flushAcpMessage(activity, notify);
      turn.status = activity.cancelled ? "interrupted" : "failed";
      if (!activity.cancelled) turn.error = { message: error.message };
    } finally {
      try {
        if (!ignored) {
          turn.completedAt = nowSeconds();
          await store.change((data) => {
            const s = store.session(data, session.id);
            const index = s.turns.findIndex(({ id }) => id === turn.id);
            if (index === -1) s.turns.push(turn);
            else s.turns[index] = turn;
            s.updatedAt = turn.completedAt;
            if (activity.contextAccepted) delete s.nativeContextPending;
            if (!s.name && activity.title) s.name = activity.title;
            if (activity.usage)
              s.tokenUsage = {
                last: { totalTokens: activity.usage.used },
                modelContextWindow: activity.usage.size,
              };
          });
          for (const item of turn.items.slice(initialItemCount))
            notify("item/completed", { turnId: turn.id, item });
          if (!session.name && activity.title)
            notify("thread/name/updated", { threadName: activity.title });
          if (activity.usage)
            notify("thread/tokenUsage/updated", {
              turnId: turn.id,
              tokenUsage: {
                last: { totalTokens: activity.usage.used },
                modelContextWindow: activity.usage.size,
              },
            });
          notify("turn/completed", { turn });
        }
      } finally {
        active.delete(session.id);
        const entry = entries.get(session.id);
        if (entry) idle(session.id, entry);
        done.resolve();
      }
    }
    return { turn, compacted: activity.compacted };
  }
  function cancelActive(id) {
    const activity = active.get(id);
    if (!activity || activity.cancelled) return;
    activity.cancelled = true;
    activity.controller.abort();
    const entry = entries.get(id);
    if (activity.submitted && entry && !entry.client.closed)
      entry.client.notify("session/cancel", { sessionId: entry.nativeId });
  }
  async function replace(session, record, input, blocks) {
    const id = session.id;
    pending.set(id, record.id);
    cancelActive(id);
    try {
      await active.get(id)?.done;
      const current = store.session(await store.read(), id);
      if (pending.get(id) !== record.id) {
        const turn = {
          ...record,
          status: "interrupted",
          completedAt: nowSeconds(),
        };
        await store.change((data) => store.session(data, id).turns.push(turn));
        for (const item of turn.items)
          emit({
            method: "item/completed",
            params: { threadId: id, turnId: turn.id, item },
          });
        emit({ method: "turn/completed", params: { threadId: id, turn } });
        return { turn };
      }
      return await prompt(current, record, input, blocks);
    } finally {
      if (pending.get(id) === record.id) pending.delete(id);
    }
  }
  async function replay(session) {
    const previous = entries.get(session.id);
    if (previous) discard(session.id, previous);
    const history = [];
    const client = spawn((method, p) => {
      if (method === "session/update" && p.sessionId === session.nativeId)
        history.push(p.update);
    });
    try {
      await initialize(client);
      const role = await readRole();
      await client.call("session/load", {
        sessionId: session.nativeId,
        cwd: session.cwd,
        mcpServers: [],
        _meta: { antigravity: { systemPrompt: { append: role } } },
      });
      return history;
    } finally {
      client.close();
    }
  }
  return {
    connect,
    open,
    prompt,
    replace,
    replay,
    active,
    entries,
    tokens,
    catalogue: catalogue.get,
    error: () => connectionError,
    busy: (id) => active.has(id) || pending.has(id),
    interrupt(id) {
      pending.delete(id);
      cancelActive(id);
    },
    discard(id) {
      const entry = entries.get(id);
      if (entry) discard(id, entry);
    },
    close() {
      catalogue.close();
      catalogueClient?.close();
      for (const [id, entry] of entries) discard(id, entry);
    },
  };
}
