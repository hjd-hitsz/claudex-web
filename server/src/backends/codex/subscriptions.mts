import type { CodexClient, createUpstream } from "./upstream.mjs";
import type {
  CallResult,
  CodexSessionSettings,
  NativeCollaboration,
  NativeParams,
  ResumeParams,
} from "./native-protocol.d.mts";
import { codexSecretaryTurn } from "./secretary-mode.mjs";

type ResumeOptions = { cwd?: string | null; inheritPermissions?: boolean };

export const codexFullAccess = {
  approvalPolicy: "never",
  sandbox: "danger-full-access",
} as const;

type SubscriptionDependencies = {
  transport: Pick<
    ReturnType<typeof createUpstream>,
    "call" | "ready" | "pending"
  >;
  compactions: { busy(threadId: string): boolean };
  activeTurns: { has(threadId: string): boolean };
  activeThreads: Set<string>;
  backgroundHandoffPending?: (threadId: string) => boolean;
  readSecretaryRole?: (threadId: string) => Promise<string | undefined>;
  resumeNative?: (
    params: ResumeParams,
    role?: string,
  ) => Promise<CallResult<"thread/resume">>;
};

export function createSubscriptions({
  transport,
  compactions,
  activeTurns,
  activeThreads,
  backgroundHandoffPending = () => false,
  readSecretaryRole,
  resumeNative = (params) => transport.call("thread/resume", params),
}: SubscriptionDependencies) {
  const subscriptions = new Map<string, Set<CodexClient>>(),
    releasing = new Map<string, Promise<CallResult<"thread/unsubscribe">>>(),
    resuming = new Map<string, Promise<void>>(),
    retained = new Map<string, Set<symbol>>();
  const unwrittenThreads = new Set<string>();
  const activeGoals = new Set<string>();
  const roles = new Map<string, string | undefined>();
  const settings = new Map<string, CodexSessionSettings>();
  const closing = new Map<string, (error?: Error) => void>();
  function recordSettings(threadId: string, session: CodexSessionSettings) {
    const { model, reasoningEffort, collaborationMode } = session;
    settings.set(threadId, { model, reasoningEffort, collaborationMode });
  }
  function closedThread(threadId: string) {
    roles.delete(threadId);
    settings.delete(threadId);
    closing.get(threadId)?.();
  }
  async function releaseForRoleChange(threadId: string) {
    if (
      unwrittenThreads.has(threadId) ||
      compactions.busy(threadId) ||
      activeTurns.has(threadId) ||
      activeThreads.has(threadId) ||
      backgroundHandoffPending(threadId)
    )
      throw new Error("请等待 Codex 会话空闲后切换委派模式。");
    const completed = Promise.withResolvers<void>();
    const timeout = setTimeout(
      () =>
        completed.reject(
          new Error("Codex 会话仍由原生客户端持有，当前无法切换委派模式。"),
        ),
      8000,
    );
    const settle = (error?: Error) =>
      error ? completed.reject(error) : completed.resolve();
    closing.set(threadId, settle);
    try {
      const release = transport
        .call("thread/unsubscribe", { threadId }, { trackThread: false })
        .then(({ status }) => {
          subscriptions.delete(threadId);
          if (status === "notLoaded") closedThread(threadId);
        });
      await Promise.all([release, completed.promise]);
      subscriptions.delete(threadId);
    } finally {
      clearTimeout(timeout);
      if (closing.get(threadId) === settle) closing.delete(threadId);
    }
  }
  function updateGoal(threadId: string, goal: { status?: string } | null) {
    if (goal?.status === "active") activeGoals.add(threadId);
    else activeGoals.delete(threadId);
  }
  async function resumeForWrite(
    threadId: string,
    { cwd, inheritPermissions = false }: ResumeOptions = {},
  ) {
    if (!readSecretaryRole && subscriptions.has(threadId)) return;
    if (!resuming.has(threadId)) {
      const resume = Promise.resolve()
        .then(async () => {
          const role = await readSecretaryRole?.(threadId);
          if (subscriptions.has(threadId) || roles.has(threadId)) {
            if (Boolean(roles.get(threadId)) !== Boolean(role))
              await releaseForRoleChange(threadId);
            else if (subscriptions.has(threadId)) {
              roles.set(threadId, role);
              return;
            }
          }
          const session = await resumeNative(
            {
              threadId,
              ...(cwd && { cwd }),
              excludeTurns: true,
              ...(!inheritPermissions && codexFullAccess),
              config: { thread_unload_delay_secs: 0 },
            },
            role,
          );
          const { thread } = session;
          if (!subscriptions.has(thread.id))
            subscriptions.set(thread.id, new Set());
          roles.set(thread.id, role);
          recordSettings(thread.id, session);
          if (thread.status?.type === "active") activeThreads.add(thread.id);
        })
        .finally(() => {
          if (resuming.get(threadId) === resume) resuming.delete(threadId);
        });
      resuming.set(threadId, resume);
    }
    await resuming.get(threadId);
  }
  function releaseUnusedThreads() {
    for (const [threadId, owners] of subscriptions) {
      if (
        !transport.ready ||
        compactions.busy(threadId) ||
        activeGoals.has(threadId) ||
        (unwrittenThreads.has(threadId) && owners.size) ||
        activeTurns.has(threadId) ||
        activeThreads.has(threadId) ||
        backgroundHandoffPending(threadId) ||
        retained.has(threadId) ||
        resuming.has(threadId) ||
        releasing.has(threadId) ||
        [...transport.pending.values()].some(
          (request) => request.threadId === threadId,
        )
      )
        continue;
      // 原生确认仅释放本连接；其他订阅者仍可持有会话。
      const release = transport
        .call(
          "thread/unsubscribe",
          { threadId },
          { trackThread: false, timeoutMessage: "取消对话订阅超时" },
        )
        .then((result) => {
          if (subscriptions.get(threadId) === owners) {
            subscriptions.delete(threadId);
            unwrittenThreads.delete(threadId);
          }
          return result;
        })
        .catch((error) => {
          console.error("Thread unsubscribe:", error.message);
          throw error;
        })
        .finally(() => {
          if (releasing.get(threadId) === release) releasing.delete(threadId);
        });
      release.catch(() => {});
      releasing.set(threadId, release);
    }
  }
  return {
    subscriptions,
    releasing,
    resuming,
    unwrittenThreads,
    updateGoal,
    resumeForWrite,
    closedThread,
    recordRole(threadId: string, session: CodexSessionSettings, role?: string) {
      if (!subscriptions.has(threadId)) roles.set(threadId, role);
      recordSettings(threadId, session);
    },
    secretaryTurn(threadId: string, params: NativeParams) {
      const session = settings.get(threadId);
      if (!readSecretaryRole || !session) return params;
      const next = codexSecretaryTurn(params, session, roles.get(threadId));
      if (next.collaborationMode)
        settings.set(threadId, {
          ...session,
          collaborationMode: next.collaborationMode as NativeCollaboration,
        });
      return next;
    },
    releaseUnusedThreads,
    retainThread(threadId: string) {
      const leases = retained.get(threadId) ?? new Set<symbol>();
      retained.set(threadId, leases);
      const lease = Symbol();
      leases.add(lease);
      return () => {
        leases.delete(lease);
        if (!leases.size && retained.get(threadId) === leases)
          retained.delete(threadId);
        releaseUnusedThreads();
      };
    },
    releaseClient(client: CodexClient) {
      for (const owners of subscriptions.values()) owners.delete(client);
      releaseUnusedThreads();
    },
    reset() {
      subscriptions.clear();
      releasing.clear();
      resuming.clear();
      retained.clear();
      unwrittenThreads.clear();
      activeGoals.clear();
      roles.clear();
      settings.clear();
      for (const settle of closing.values())
        settle(new Error("Codex 后端连接已断开。"));
      closing.clear();
    },
  };
}
