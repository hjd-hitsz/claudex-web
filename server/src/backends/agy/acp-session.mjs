import { secretaryAgent } from "./secretary-prompts.mjs";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateFile } from "../../private-file.mjs";
import { createAcpClient } from "./acp-client.mjs";
import { createAgyTurns } from "./acp-turns.mjs";
import {
  acpCommands,
  applyAcpUpdate,
  waitForAcpCommands,
} from "./acp-events.mjs";
import { applyAcpSelection, updateAcpConfiguration } from "./acp-models.mjs";
import { createAgyCompactions } from "./compactions.mjs";
import {
  createAgyModelCatalogue,
  readAcpCatalogue,
} from "./model-catalogue.mjs";
import { resolveSourcePrompt } from "../delegation/settings.mjs";
import { nowSeconds } from "./session-store.mjs";
import { savedAgyAgent, secretaryName } from "./native-agent.mjs";
import { restoreAgyToolResults } from "./tmp_function/history-tool-results.mjs";
import {
  installAgyCompactor,
  createAgySessionCompaction,
} from "./tmp_function/session-compact.mjs";

const mcp = fileURLToPath(new URL("./delegation-mcp.mjs", import.meta.url));
const capable = (response, key) =>
  response.agentCapabilities?.sessionCapabilities?.[key];

export function createAcpSessions({
  store,
  getBackend,
  socket,
  execution,
  emit,
  createClient = createAcpClient,
  readAgent = savedAgyAgent,
  readCheckpoint,
}) {
  const entries = new Map();
  const tokens = new Map();
  const active = new Map();
  const pending = new Map();
  const rewriting = new Set();
  const compactions = createAgyCompactions(readCheckpoint);
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

  const spawn = (onUpdate, onRequest, onExit, agent) =>
    createClient({
      executable: path,
      agent,
      cwd: launchDir(),
      proxy: getBackend().proxy,
      onUpdate,
      onRequest,
      onExit,
    });
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
    await installAgyCompactor(launchDir());
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
    const commandReady = Promise.withResolvers();
    let commands = [];
    const client = spawn((method, params) => {
      const available =
        method === "session/update" && acpCommands(params.update);
      if (available) {
        commands = available;
        commandReady.resolve();
      }
    });
    catalogueClient = client;
    try {
      const models = await readAcpCatalogue(
        client,
        initialize,
        launchDir(),
        readRole,
        () => waitForAcpCommands(commandReady.promise),
      );
      return { ...models, commands };
    } finally {
      client.close();
      catalogueClient = undefined;
    }
  }
  async function commands(entry) {
    if (entry?.commands !== undefined) return entry.commands;
    const fallback = await catalogue.get();
    return entry?.commands ?? fallback.commands;
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
    const earlyCommands = new Map();
    function setCommands(commands) {
      if (JSON.stringify(entry.commands) === JSON.stringify(commands)) return;
      entry.commands = commands;
      notify("lan/agy/commands", {});
    }
    entry.client = spawn(
      (method, p) => {
        if (entries.get(session.id) !== entry || method !== "session/update")
          return;
        const commands = acpCommands(p.update);
        if (p.sessionId !== entry.nativeId) {
          if (commands && !entry.nativeId)
            earlyCommands.set(p.sessionId, commands);
          return;
        }
        if (p.update.configOptions) updateAcpConfiguration(entry, p.update);
        if (commands) setCommands(commands);
        const activity = active.get(session.id);
        if (activity?.entry === entry && activity.submitted) {
          if (p.update.sessionUpdate === "session_info_update")
            activity.title = p.update.title;
          if (!activity.compaction.update(p.update))
            applyAcpUpdate(activity, p.update, notify);
        }
      },
      (method, params) => {
        const activity = active.get(session.id);
        if (
          entries.get(session.id) !== entry ||
          activity?.entry !== entry ||
          !activity.submitted
        )
          throw new Error("agy 原生会话当前没有已提交的轮次");
        return execution.acpRequest(entry, method, params);
      },
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
      if (earlyCommands.has(entry.nativeId))
        setCommands(earlyCommands.get(entry.nativeId));
      earlyCommands.clear();
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

  async function prepareHistory(session) {
    const { entry } = await prepareSession(session, await readRole(), {
      controller: new AbortController(),
    });
    await applyAcpSelection(entry, {}, session);
    idle(session.id, entry);
    return entry;
  }

  const { prompt, steer, cancelActive } = createAgyTurns({
    active,
    entries,
    compactions,
    store,
    execution,
    emit,
    readRole,
    prepareSession,
    commands,
    toolResults,
    agentInfo: () => startup.agentInfo,
    idle,
  });
  function toolResults(turns, nativeIds) {
    restoreAgyToolResults(turns, nativeIds, startup?.agentInfo);
  }
  async function replace(session, record, input, blocks) {
    const id = session.id;
    pending.set(id, record.id);
    emit({ method: "lan/turnQueue/updated", params: { threadId: id } });
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
  function discardSession(id) {
    const entry = entries.get(id);
    if (entry) discard(id, entry);
  }
  async function closeForHistory(id) {
    const entry = entries.get(id);
    if (!entry) return;
    try {
      await entry.open;
      if (!entry.client.closed)
        await entry.client.call("session/close", { sessionId: entry.nativeId });
    } finally {
      discard(id, entry);
      await entry.client.exited;
    }
  }
  return {
    connect,
    open,
    prompt,
    steer,
    replace,
    replay,
    active,
    pending,
    rewriting,
    prepareHistory,
    toolResults,
    entries,
    tokens,
    catalogue: catalogue.get,
    commands: (id) => commands(entries.get(id)),
    promptCapabilities: () => startup?.agentCapabilities?.promptCapabilities,
    compactions: compactions.entries,
    compact: createAgySessionCompaction({
      store,
      active,
      compactions,
      launchDir,
      emit,
      readRole,
      discard: discardSession,
      spawn,
      initialize,
    }),
    error: () => connectionError,
    busy: (id) => active.has(id) || pending.has(id) || rewriting.has(id),
    interrupt(id) {
      pending.delete(id);
      cancelActive(id);
    },
    discard: discardSession,
    closeForHistory,
    agentInfo: () => startup?.agentInfo,
    close() {
      for (const id of active.keys()) cancelActive(id);
      catalogue.close();
      catalogueClient?.close();
      for (const [id, entry] of entries) discard(id, entry);
    },
  };
}
