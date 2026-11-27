import { backgroundTaskViews } from "./background-task-views.mjs";
import { createCodexBackgroundActivity } from "./background-activity.mjs";
import {
  backgroundParams,
  backgroundTerminals,
  backgroundTurnParams,
} from "./background-terminals.mjs";
import { threadMethods } from "./methods.mjs";
import { referenceToolParams } from "./reference-tools.mjs";
import { codexConversationToolParams } from "./conversation-tools.mjs";
import { createCodexConversationManager } from "./conversation-manager.mjs";
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
import { createStreamingMessages } from "./streaming-messages.mjs";
import type { readConfig } from "../../config.mjs";
import type { createBackgroundService } from "./background-service.mjs";
import type {
  CodexSessionSettings,
  NativeParams,
  RpcMessage,
} from "./native-protocol.d.mts";
import type { CodexClient } from "./upstream.mjs";

const conversationUserRequests = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
const conversationWrites = new Set([
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/revert",
  "thread/rollback",
  "review/start",
]);

type SubagentSettings = Parameters<typeof subagentModelParams>[2];
type CodexAdapterOptions = {
  backend: SubagentSettings & { url: string; dataDir: string };
  config: ReturnType<typeof readConfig>;
  version: { displayVersion: string };
  send: (client: CodexClient, message: RpcMessage) => void;
  broadcast: (message: RpcMessage) => void;
  background?: ReturnType<typeof createBackgroundService>;
  backgroundEnabled?: () => boolean;
  readSubagentSettings?: () => Promise<SubagentSettings>;
  conversationToolEndpoint?: Parameters<typeof codexConversationToolParams>[2];
  readSecretaryRole?: (
    threadId?: string,
    selected?: boolean,
  ) => Promise<string | undefined>;
};

export function createCodexAdapter({
  backend,
  config,
  version,
  send,
  broadcast,
  background,
  backgroundEnabled = () => false,
  readSubagentSettings = async () => backend,
  conversationToolEndpoint,
  readSecretaryRole,
}: CodexAdapterOptions) {
  config = { ...config, upstreamUrl: backend.url, codexHome: backend.dataDir };
  const questions = new Map<string, RpcMessage>();
  const activeTurns = new Map<string, string>();
  const executionStatuses = new Map<
    string,
    { turnId: string; kind: "retrying"; message: string }
  >();
  const activeThreads = new Set<string>();
  const terminals = new Map<string, { buffer: string; running: boolean }>();
  const compactions = createCompactions(broadcast);
  const streamingMessages = createStreamingMessages();
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
    prepareParams: async (method, params) =>
      sessionParams(
        method,
        method === "turn/start" && params.threadId
          ? subscriptions.secretaryTurn(params.threadId, params)
          : params,
        threadMethods.has(method)
          ? await readSecretaryRole?.(params.threadId)
          : undefined,
      ),
    onReady() {
      broadcast(state());
      for (const [threadId, entry] of compactions.entries)
        if (entry.status === "reconnecting")
          checkCompaction(threadId).catch(() => {});
    },
    onEvent(message) {
      if (message.method === "thread/closed" && message.params?.threadId)
        subscriptions.closedThread(message.params.threadId);
      conversationManager.onEvent(message);
      handoff.event(message);
      const discardedStreamingMessageIds = streamingMessages.event(message);
      events.onEvent(
        discardedStreamingMessageIds
          ? {
              ...message,
              params: { ...message.params, discardedStreamingMessageIds },
            }
          : message,
      );
    },
    onResponse(request, message) {
      const result = message.result as
        (CodexSessionSettings & { thread?: { id: string } }) | undefined;
      if (result?.thread && threadMethods.has(request.method))
        subscriptions.recordRole(
          result.thread.id,
          result,
          request.secretaryRole,
        );
      events.onResponse(request, message);
    },
    onSettled: () => subscriptions.releaseUnusedThreads(),
    onDisconnect() {
      conversationManager.disconnected();
      compactions.disconnected();
      threadNaming.clear();
      questions.clear();
      activeTurns.clear();
      executionStatuses.clear();
      activeThreads.clear();
      streamingMessages.clear();
      handoff.disconnected();
      subscriptions.reset();
      for (const terminal of terminals.values()) terminal.running = false;
      broadcast(state());
    },
  });
  async function sessionParams(
    method: string,
    params: NativeParams,
    role?: string,
  ): Promise<NativeParams> {
    const enabled = Boolean(background && backgroundEnabled());
    if (!threadMethods.has(method)) {
      return enabled ? backgroundTurnParams(method, params) : params;
    }
    return subagentModelParams(
      method,
      backgroundParams(
        method,
        codexConversationToolParams(
          method,
          referenceToolParams(method, params, config),
          conversationToolEndpoint,
          Boolean(role),
        ),
        enabled ? await background?.ensure() : null,
        config.upstreamUrl,
      ),
      await readSubagentSettings(),
    );
  }
  const threadNaming = createThreadNaming({
    call: transport.call,
    generate: (params: { text: string; model?: string }) =>
      generateThreadName({
        ...params,
        url: config.upstreamUrl,
        version: version.displayVersion,
      }),
    onError: (error: Error) => console.error("Thread title:", error.message),
  });
  const subscriptions = createSubscriptions({
    transport,
    compactions,
    activeTurns,
    activeThreads,
    backgroundHandoffPending: handoff.pending,
    readSecretaryRole,
    resumeNative: async (params, role) =>
      transport.call(
        "thread/resume",
        {
          ...(await sessionParams("thread/resume", params, role)),
          threadId: params.threadId,
        },
        { prepared: true },
      ),
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
    readAgentMessages: (threadId: string) =>
      readAgentMessages(transport.call, threadId),
    broadcast,
  });
  const { files } = methods;
  const backgroundActivity = createCodexBackgroundActivity(
    transport,
    background,
    config.upstreamUrl,
  );
  const conversationManager = createCodexConversationManager({
    transport,
    subscriptions,
    backgroundActivity,
    busy: (threadId: string, replying: boolean) =>
      compactions.busy(threadId) ||
      files.undoing.has(threadId) ||
      (!replying &&
        (activeTurns.has(threadId) || activeThreads.has(threadId))) ||
      [...questions.values()].some(
        ({ method, params }) =>
          params?.threadId === threadId &&
          conversationUserRequests.has(method ?? ""),
      ) ||
      [...transport.pending.values()].some(
        (request) =>
          request.threadId === threadId &&
          conversationWrites.has(request.method),
      ),
  });
  const events = createBridgeEvents({
    questions,
    activeTurns,
    executionStatuses,
    activeThreads,
    terminals,
    ...subscriptions,
    compactions,
    streamingMessages,
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
    includeBackground: () =>
      backgroundEnabled() || Boolean(background?.listening()),
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

  function state(): RpcMessage {
    return {
      method: "lan/state",
      params: {
        ready: transport.ready,
        questions: [...questions.values()],
        activeTurns: Object.fromEntries(activeTurns),
        executionStatuses: Object.fromEntries(executionStatuses),
        compactions: Object.fromEntries(compactions.entries),
        terminals: Object.fromEntries(terminals),
        undoneFiles: [...files.undoneFiles.values()],
      },
    };
  }
  return {
    capabilities: codexCapabilities,
    readTokenUsage: (thread: Parameters<typeof readCodexTokenUsage>[0]) =>
      readCodexTokenUsage(thread, transport.call),
    workspaceOwner: "backend",
    conversationManager,
    state,
    async receive(client: CodexClient, message: RpcMessage) {
      if (!message.method) return receive(client, message);
      const { providerId, delegationMode, ...params } = message.params || {};
      if (providerId) throw new Error("Codex 使用现有账户与模型配置");
      const role = threadMethods.has(message.method)
        ? await readSecretaryRole?.(
            message.method === "thread/resume" ? params.threadId : undefined,
            message.method === "thread/start"
              ? delegationMode === true
              : undefined,
          )
        : undefined;
      return receive(
        client,
        {
          ...message,
          params: await sessionParams(message.method, params, role),
        },
        role,
      );
    },
    connect: transport.connect,
    releaseUnusedThreads: subscriptions.releaseUnusedThreads,
    releaseClient: subscriptions.releaseClient,
    close() {
      threadNaming.clear();
      handoff.disconnected();
      streamingMessages.clear();
      transport.close();
      conversationManager.disconnected();
      subscriptions.reset();
    },
    get ready() {
      return transport.ready;
    },
  };
}
