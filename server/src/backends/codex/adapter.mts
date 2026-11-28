import { backgroundTaskViews } from "./background-task-views.mjs";
import { createCodexBackgroundActivity } from "./background-activity.mjs";
import { observeCodexWork } from "./native-activity.mjs";
import {
  backgroundParams,
  backgroundTerminals,
  backgroundTurnParams,
} from "./background-terminals.mjs";
import { threadMethods } from "./methods.mjs";
import { secretaryProjectParams } from "../../../../packages/background-terminal/project-instructions.mjs";
import { createCodexSecretaryHistory } from "./secretary-history.mjs";
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
import { requestActivity } from "../../conversation-manager/request-activity.mjs";
import { runtimeIdentity } from "../../conversation-manager/address.mjs";
import { delegationStatePaths } from "../delegation/delegated-threads.mjs";
import { createResearchThreadLookup } from "../../../../packages/background-terminal/delegation-records.mjs";
import {
  checkWebResearchAccess,
  researchSessionParams,
} from "./research-policy.mjs";

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
  backend: SubagentSettings & {
    id: string;
    type: string;
    url: string;
    dataDir: string;
  };
  config: ReturnType<typeof readConfig>;
  version: { displayVersion: string };
  send: (client: CodexClient, message: RpcMessage) => void;
  broadcast: (message: RpcMessage) => void;
  background?: ReturnType<typeof createBackgroundService>;
  backgroundEnabled?: () => boolean;
  delegationExecutor?: boolean;
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
  delegationExecutor = false,
  readSubagentSettings = async () => backend,
  conversationToolEndpoint,
  readSecretaryRole,
}: CodexAdapterOptions) {
  config = { ...config, upstreamUrl: backend.url, codexHome: backend.dataDir };
  const isResearchThread = createResearchThreadLookup({
    paths: delegationStatePaths(config.configDir),
    runtimeId: runtimeIdentity(backend),
  });
  const researchThreads = new Set<string>();
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
    enabled: (threadId) =>
      Boolean(
        background?.available &&
        (researchThreads.has(threadId) || backgroundEnabled()),
      ),
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
      if (message.method === "thread/closed" && message.params?.threadId) {
        researchThreads.delete(message.params.threadId);
        subscriptions.closedThread(message.params.threadId);
      }
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
      researchThreads.clear();
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
    research?: boolean,
    web = false,
  ): Promise<NativeParams> {
    research ??=
      (threadMethods.has(method) || method === "turn/start") &&
      (await isResearchThread(params.threadId));
    if (research && params.threadId) researchThreads.add(params.threadId);
    if (research && (threadMethods.has(method) || method === "turn/start"))
      params = researchSessionParams(method, params, web);
    const enabled = !research && Boolean(background && backgroundEnabled());
    if (!threadMethods.has(method)) {
      return enabled ? backgroundTurnParams(method, params) : params;
    }
    if (!research && role)
      params = await secretaryProjectParams(
        params,
        params.cwd ||
          (params.threadId
            ? (
                await transport.call("thread/read", {
                  threadId: params.threadId,
                  includeTurns: false,
                })
              ).thread.cwd
            : config.defaultCwd),
      );
    if (
      method !== "thread/resume" &&
      (params.threadSource == null ||
        params.threadSource === "claudex-web-projectless" ||
        params.threadSource === "codex-web-projectless")
    )
      params = { ...params, threadSource: "user" };
    return subagentModelParams(
      method,
      backgroundParams(
        method,
        codexConversationToolParams(
          method,
          referenceToolParams(method, params, config),
          conversationToolEndpoint,
          !research && Boolean(role),
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
    observeNativeWork: (threadId: string) =>
      observeCodexWork(transport, threadId),
    requestActivities: (threadId: string) =>
      [...questions.values()].flatMap(({ method, params }) => {
        const activity = requestActivity(method, params);
        return params?.threadId === threadId && activity ? [activity] : [];
      }),
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
    includeBackground: (threadId) =>
      Boolean(background?.listening()) ||
      (researchThreads.has(threadId)
        ? handoff.pending(threadId)
        : backgroundEnabled()),
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

  const secretaryHistory = createCodexSecretaryHistory(
    transport.call,
    join(config.configDir, "codex-secretary-history", runtimeIdentity(backend)),
    (thread: { cwd: string; model?: string }, role?: string) =>
      historyRequest(
        "thread/start",
        { cwd: thread.cwd, model: thread.model },
        role,
      ),
    (params: NativeParams, role?: string) =>
      historyRequest("thread/fork", params, role),
  );
  async function historyRequest(
    method: string,
    params: NativeParams,
    role?: string,
  ) {
    return transport.call(
      method,
      await sessionParams(
        method,
        {
          ...params,
          config: { ...params.config, thread_unload_delay_secs: 0 },
        },
        role,
      ),
      { prepared: true },
    );
  }
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
    async receive(
      client: CodexClient,
      message: RpcMessage,
      researchStart = false,
    ) {
      if (!message.method) {
        const request = questions.get(String(message.id));
        if (
          !delegationExecutor &&
          (await isResearchThread(request?.params?.threadId))
        )
          throw new Error("请从发起会话回应 Codex 研究委派。");
        return receive(client, message);
      }
      const { providerId, delegationMode, ...params } = message.params || {};
      if (providerId) throw new Error("Codex 使用现有账户与模型配置");
      const research =
        (delegationExecutor &&
          researchStart &&
          message.method === "thread/start") ||
        (await isResearchThread(params.threadId));
      if (research && params.threadId) researchThreads.add(params.threadId);
      if (!delegationExecutor)
        checkWebResearchAccess(message.method, params, research);
      const continuing = message.method === "lan/delegation/secretary/continue";
      if (continuing) {
        const threadId = params.threadId;
        if (!threadId || research) throw new Error("此对话无法创建秘书续接。");
        if (compactions.busy(threadId) || handoff.pending(threadId))
          throw new Error("请等待此对话维护结束后开启委派模式。");
      }
      const role =
        !research && (continuing || threadMethods.has(message.method))
          ? await readSecretaryRole?.(
              params.threadId,
              continuing
                ? true
                : message.method === "thread/start" ||
                    delegationMode !== undefined
                  ? delegationMode === true
                  : undefined,
            )
          : undefined;
      if (continuing && !role) throw new Error("当前后端缺少秘书角色设置。");
      const projected = await secretaryHistory.request(
        message.method,
        params,
        role,
      );
      if (projected) return send(client, { id: message.id, result: projected });
      return receive(
        client,
        {
          ...message,
          params: await sessionParams(
            message.method,
            params,
            role,
            research,
            !delegationExecutor,
          ),
        },
        role,
      );
    },
    connect: transport.connect,
    releaseUnusedThreads: subscriptions.releaseUnusedThreads,
    releaseClient: subscriptions.releaseClient,
    close() {
      secretaryHistory.close();
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
