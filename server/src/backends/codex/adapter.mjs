import { backgroundTaskViews } from "./background-task-views.mjs";
import {
  backgroundParams,
  backgroundTerminals,
} from "./background-terminals.mjs";
import { threadMethods } from "./methods.mjs";
import { referenceToolParams } from "./reference-tools.mjs";
import { subagentModelParams } from "./subagent-model.mjs";
import { join } from "node:path";
import { codexCapabilities } from "../../../../shared/backend-capabilities.mjs";
import { readAgentMessages } from "../../agent-messages.mjs";
import { createCompactions } from "../../compaction.mjs";
import { createThreadNaming, generateThreadName } from "../../thread-names.mjs";
import { createUpstream } from "./upstream.mjs";
import { createSubscriptions } from "./subscriptions.mjs";
import { createNativeBackgroundHandoff } from "./native-background-handoff.mjs";
import { createCompactionRecovery } from "./compaction-recovery.mjs";
import { createBridgeEvents } from "./events.mjs";
import { createRequestHandler } from "./requests.mjs";
import { createProductMethods } from "../../bridge/product-methods.mjs";
import { readCodexTokenUsage } from "./token-usage.mjs";

export function createCodexAdapter({
  backend,
  config,
  version,
  send,
  broadcast,
  background,
  backgroundEnabled = () => false,
  readSubagentSettings = async () => backend,
}) {
  config = { ...config, upstreamUrl: backend.url, codexHome: backend.dataDir };
  const questions = new Map();
  const activeTurns = new Map();
  const activeThreads = new Set();
  const terminals = new Map();
  const compactions = createCompactions(broadcast);
  const handoff = createNativeBackgroundHandoff({
    background,
    enabled: () => Boolean(background?.available && backgroundEnabled()),
    upstream: config.upstreamUrl,
    onSettled: () => subscriptions.releaseUnusedThreads(),
  });
  const transport = createUpstream({
    config,
    version,
    send,
    onReady() {
      broadcast(state());
      for (const [threadId, entry] of compactions.entries)
        if (entry.status === "reconnecting")
          checkCompaction(threadId).catch(() => {});
    },
    onEvent(message) {
      handoff.event(message);
      events.onEvent(message);
    },
    onResponse: (request, message) => events.onResponse(request, message),
    onSettled: () => subscriptions.releaseUnusedThreads(),
    onDisconnect() {
      compactions.disconnected();
      threadNaming.clear();
      questions.clear();
      activeTurns.clear();
      activeThreads.clear();
      handoff.disconnected();
      subscriptions.reset();
      for (const terminal of terminals.values()) terminal.running = false;
      broadcast(state());
    },
  });
  const nativeCall = transport.call;
  const sessionParams = async (method, params) =>
    subagentModelParams(
      method,
      backgroundParams(
        method,
        referenceToolParams(method, params, config),
        threadMethods.has(method) && backgroundEnabled()
          ? await background.ensure()
          : null,
        config.upstreamUrl,
      ),
      threadMethods.has(method) ? await readSubagentSettings() : backend,
    );
  transport.call = async (method, params, options) =>
    nativeCall(method, await sessionParams(method, params), options);
  const threadNaming = createThreadNaming({
    call: transport.call,
    generate: (params) =>
      generateThreadName({
        ...params,
        url: config.upstreamUrl,
        version: version.displayVersion,
      }),
    onError: (error) => console.error("Thread title:", error.message),
  });
  const subscriptions = createSubscriptions({
    transport,
    compactions,
    activeTurns,
    activeThreads,
    backgroundHandoffPending: handoff.pending,
  });
  const checkCompaction = createCompactionRecovery({
    transport,
    compactions,
    ...subscriptions,
  });
  const methods = createProductMethods({
    config,
    projectModelsDirectory: config.configDir,
    legacyProjectModelsDirectory: join(config.codexHome, "codex-web"),
    call: transport.call,
    activeTurns,
    activeThreads,
    checkCompaction,
    readAgentMessages: (threadId) =>
      readAgentMessages(transport.call, threadId),
    broadcast,
  });
  const { files } = methods;
  const events = createBridgeEvents({
    questions,
    activeTurns,
    activeThreads,
    terminals,
    ...subscriptions,
    compactions,
    threadNaming,
    send,
    broadcast,
    state,
  });
  const receive = createRequestHandler({
    transport,
    compactions,
    threadNaming,
    activeTurns,
    activeThreads,
    terminals,
    questions,
    undoing: files.undoing,
    ...subscriptions,
    ...methods,
    online: new Map([
      ...methods.online,
      ...backgroundTaskViews(background, config.upstreamUrl),
    ]),
    includeBackground: () => backgroundEnabled() || background.listening(),
    waitForBackgroundHandoff: handoff.wait,
    backgroundCall:
      background?.available &&
      backgroundTerminals(
        background.directory,
        config.upstreamUrl,
        transport.call,
        undefined,
        backgroundEnabled,
      ),
    send,
    broadcast,
  });

  function state() {
    return {
      method: "lan/state",
      params: {
        ready: transport.ready,
        questions: [...questions.values()],
        activeTurns: Object.fromEntries(activeTurns),
        compactions: Object.fromEntries(compactions.entries),
        terminals: Object.fromEntries(terminals),
        undoneFiles: [...files.undoneFiles.values()],
      },
    };
  }
  return {
    capabilities: codexCapabilities,
    readTokenUsage: (thread) => readCodexTokenUsage(thread, transport.call),
    workspaceOwner: "backend",
    state,
    async receive(client, message) {
      if (!message.method) return receive(client, message);
      const { providerId, ...params } = message.params || {};
      if (providerId) throw new Error("Codex 使用现有账户与模型配置");
      return receive(client, {
        ...message,
        params: await sessionParams(message.method, params),
      });
    },
    connect: transport.connect,
    releaseUnusedThreads: subscriptions.releaseUnusedThreads,
    releaseClient: subscriptions.releaseClient,
    close() {
      threadNaming.clear();
      handoff.disconnected();
      transport.close();
      subscriptions.reset();
    },
    get ready() {
      return transport.ready;
    },
  };
}
