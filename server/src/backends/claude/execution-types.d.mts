import type { createCompactions } from "../../compaction.mjs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  EffortLevel,
  HookCallback,
  PermissionResult,
  Query,
  SDKMessage,
  SDKRateLimitInfo,
  SDKSessionStateChangedMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";

import type { createInputStream } from "./input-stream.mjs";
import type { createNativeCommands } from "./native-commands.mjs";
import type {
  ConversationInput,
  ConversationThread,
  ConversationTool,
} from "./conversation-protocol.d.mts";

export type PendingQuestion = {
  threadId: string;
  input: AskUserQuestionInput | Record<string, unknown>;
  permission?: boolean;
  question: { id: string; method: string; params: Record<string, unknown> };
  resolve: (result: PermissionResult) => void;
};

export type ProcessIdentity = {
  pid: number;
  parentPid: number;
  state: string;
  startTime: string;
  bootId: string;
};

export type SessionRecord = {
  id: string;
  cwd: string;
  archived?: boolean;
  deleted?: boolean;
  nativeSessionId?: string;
  initialized?: boolean;
  delegationMode?: boolean;
  secretaryHistoryVersion?: number;
  providerId?: string;
  model?: string;
  modelTokens?: number;
  internalInputIds?: Record<string, boolean>;
  nativeProcess?: ProcessIdentity | null;
  nativeChildren?: ProcessIdentity[];
  turns?: Record<string, ExecutionTurn>;
  skills?: SDKSystemMessage["skills"];
  mcpServers?: SDKSystemMessage["mcp_servers"];
  commands?: string[];
  agentsAvailable?: string[];
  queue?: QueuedInput[];
  active?: QueuedInput | { id: string; automatic: true } | null;
  updatedAt?: number;
  mode?: string;
  review?: boolean;
  effort?: QueuedExecution["effort"];
  serviceTier?: string | null;
  name?: string;
  historySearchAll?: boolean;
  inputTurns?: Record<string, string>;
  compaction?: {
    status: string;
    turnId?: string;
    completedAt?: number;
    error?: string;
  };
  goal?: { id: string; status: string } | null;
  backgroundTasks?: Record<string, { status: string }>;
  extraItems?: Record<string, { id: string; type: string }>;
  peerInputs?: Record<
    string,
    {
      nativeSessionId: string;
      cwd: string;
      from: ConversationThread;
      sourceMessageId?: string;
      nativeAccepted?: boolean;
      nativeReceipt?: "claude-native-stream" | "claude-native-result";
      rejected?: string;
    }
  >;
  agentCalls?: Record<
    string,
    {
      toolUseId: string;
      turnId?: string;
      initialTask: string;
      name: string;
      agentType?: string;
    }
  >;
  agents?: Record<
    string,
    {
      agentId: string;
      name: string;
      agentType: string;
      parentNativeId: string;
      turnId?: string;
      toolUseId?: string;
      initialTask?: string;
    }
  >;
};

export type SaveSession = (
  id: string,
  update: (session: SessionRecord) => SessionRecord | Promise<SessionRecord>,
) => Promise<unknown>;

export type ExecutionTurn = {
  id: string;
  mode: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  startedAt: number;
  completedAt?: number;
  nativeAnchorId?: string;
  automatic?: boolean;
  nativeMessageIds?: string[];
  error?: { message: string };
  items: { id: string; type: string; phase?: string }[];
};

export type QueuedExecution = {
  id: string;
  model?: string;
  providerId?: string;
  effort?: EffortLevel | "";
  serviceTier?: string | null;
  mode: string;
  review?: boolean;
  compact?: boolean;
  delegation?: "research" | "implementation";
  delegationMode?: boolean;
};

export type InputPart = { type: string; text?: string; url?: string };
export type QueuedInput = QueuedExecution & {
  id: NonNullable<SDKUserMessage["uuid"]>;
  status: "queued" | "uncertain";
  input: readonly InputPart[];
  goalId?: string;
  createdAt: number;
  peer?: ConversationInput;
};

export type ActiveExecution = {
  turn: ExecutionTurn;
  queued: Pick<QueuedInput, "review" | "compact" | "peer" | "delegation">;
  query?: Query | null;
  interrupted?: boolean;
  goalId?: string;
  automatic?: boolean;
  inputIds: Set<string>;
  peerInputIds?: Set<string>;
  completedInputs?: Set<string>;
  promptError?: unknown;
  status?: {
    turnId: string;
    kind: "retrying";
    attempt: number;
    retryAt: number;
    message: string;
  } | null;
};

export type ExecutionBackend = {
  id: string;
  executable: string;
  dataDir: string;
  args?: string[];
  proxy?: unknown;
  subagentModel?: string;
  subagentProviderId?: string;
  subagentEffort?: string;
};

export type ExecutionProvider = {
  id: string;
  models: string[];
  protocol?: string;
  native?: false;
  modelCapabilities?: Record<
    string,
    { supportedEffortLevels?: string[]; supportsFastMode?: boolean }
  >;
};

export type SubagentProvider =
  | ExecutionProvider
  | {
      id: string;
      native: true;
      dataDir: string;
      baseUrl: string;
    };

export type SessionDependencies = {
  backend: ExecutionBackend;
  session: SessionRecord;
  queued: QueuedExecution;
  providers: {
    get(
      backendId: string,
      providerId?: string,
    ): Promise<ExecutionProvider | null | undefined>;
  };
  subagentProvider?: SubagentProvider | null;
  secretary: boolean;
  secretaryRole?: string;
  save: SaveSession;
  emit: (method: string, params: Record<string, unknown>) => void;
  broadcast: (message: {
    method: string;
    params: Record<string, unknown>;
  }) => void;
  questions: Map<string, PendingQuestion>;
  observeMessage?: (
    threadId: string,
    message: SDKMessage,
  ) => void | Promise<void>;
  callConversationTool?: ConversationTool;
  goals: {
    beforeTool(threadId: string): ReturnType<HookCallback>;
    observe(
      threadId: string,
      message: SDKMessage,
      process: object,
    ): Promise<unknown>;
  };
  tasks: {
    event(
      threadId: string,
      message: SDKMessage,
      process: object,
    ): Promise<unknown>;
  };
  current: () => ActiveExecution | undefined | null;
  finish: (message: SDKResultMessage) => Promise<unknown>;
  failed: (error: unknown) => Promise<unknown>;
  beginActivity: (message: SDKMessage) => Promise<unknown>;
};

export type ExecutionActivity = {
  input: ReturnType<typeof createInputStream>;
  commands: ReturnType<typeof createNativeCommands>;
  providerId?: string;
  providerKey?: string;
  subagentProviderKey?: string;
  subagentSettingsKey: string;
  subagentSettingsDirty?: boolean;
  model?: string;
  cwd: string;
  modelTokens: number;
  lastTurnId: string;
  lastActivityAt: number;
  settingsEnvironment: (
    model?: string,
    effort?: string,
  ) => Record<string, string>;
  configureSubagent: (
    backend: ExecutionBackend,
    provider?: SubagentProvider | null,
  ) => Promise<boolean>;
  retired?: boolean;
  child?: ChildProcessWithoutNullStreams;
  ownerReady?: Promise<unknown>;
  ownerError?: unknown;
  fileSuggestionsError?: unknown;
  nativeState?: SDKSessionStateChangedMessage["state"];
  correlatedInput?: boolean;
  activityPending?: boolean;
  rateLimits?: Map<string, SDKRateLimitInfo>;
  terminalCommands?: string[];
  ended?: boolean;
};

type SavedIndex = { sessions: Record<string, SessionRecord> };
export type RuntimeDependencies = Pick<
  SessionDependencies,
  | "providers"
  | "broadcast"
  | "questions"
  | "observeMessage"
  | "callConversationTool"
> & {
  backend: ExecutionBackend & { stateDir: string };
  storage: {
    read(): Promise<SavedIndex>;
    update(
      change: (data: SavedIndex) => SavedIndex | Promise<SavedIndex>,
    ): Promise<unknown>;
  };
  compactions: ReturnType<typeof createCompactions>;
  readSecretaryRole?: () => Promise<string>;
  readLegacyDelegationMode?: (threadId: string) => Promise<boolean>;
  readSubagentSettings?: () => Promise<{
    subagentModel: string;
    subagentEffort: string;
    subagentProviderId: string;
  }>;
};
export type TurnRequest = Partial<
  Pick<
    QueuedInput,
    | "model"
    | "providerId"
    | "effort"
    | "serviceTier"
    | "review"
    | "goalId"
    | "delegation"
  >
> & {
  input: readonly InputPart[];
  cwd?: string;
  collaborationMode?: { mode?: string };
};
