import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import { createConversationGateway } from "./gateway.mjs";
import { openConversationStore } from "./store.mjs";
import { conversationArguments } from "./tools.mjs";

const receiptStates = new Set([
  "deferred",
  "queued",
  "delivered",
  "failed",
  "unknown",
]);
const publicStatus = (status) =>
  status === "dispatching" ? "unknown" : status;
const statusOf = (value) => value || "unknown";
const stringFilter = (value, query) =>
  !query || value?.toLocaleLowerCase().includes(query.toLocaleLowerCase());
const dispatchKey = ({ runtimeId, threadId }) =>
  JSON.stringify([runtimeId, threadId]);
const replyPriority = (item) =>
  Number(item.status === "accepted" && !!item.replyTo);

function runtimeIdentity(backend) {
  return createHash("sha256")
    .update(
      JSON.stringify([backend.id, backend.type, backend.url, backend.dataDir]),
    )
    .digest("hex")
    .slice(0, 32);
}

function externalId({ runtimeId, threadId }) {
  return `conversation:${runtimeId}:${Buffer.from(threadId).toString("base64url")}`;
}

function decodeAddress(value = "") {
  const match = /^conversation:([a-f0-9]{32}):([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new Error("会话标识无效");
  const address = {
    runtimeId: match[1],
    threadId: Buffer.from(match[2], "base64url").toString("utf8"),
  };
  if (!address.threadId || externalId(address) !== value)
    throw new Error("会话标识无效");
  return address;
}

function sameAddress(left, right) {
  return left.runtimeId === right.runtimeId && left.threadId === right.threadId;
}

function canRoute(senderRuntime, recipientRuntime) {
  return senderRuntime === recipientRuntime;
}

function threadInfo(thread, { runtimeId, threadId }) {
  return {
    runtimeId,
    threadId,
    title: thread?.title || "",
    cwd: thread?.cwd || "",
  };
}

function publicThread(thread) {
  const { title, cwd } = threadInfo(thread, thread);
  return { threadId: externalId(thread), title, cwd };
}

function view({
  id,
  requestId,
  replyTo,
  from,
  to,
  body,
  acceptedAt,
  status,
  receipt,
}) {
  return {
    messageId: id,
    requestId,
    replyTo,
    from: publicThread(from),
    to: publicThread(to),
    body,
    acceptedAt,
    status: publicStatus(status),
    receipt,
  };
}

function validateKeys(args, fields) {
  if (
    Object.keys(args).some(
      (field) => field !== "action" && !fields.includes(field),
    )
  )
    throw new Error("参数与当前会话操作不匹配");
}

export function createConversationManager({
  configDir,
  retryMs = 5000,
  reportError = (error) =>
    console.error("Conversation manager:", error.message),
}) {
  const backends = new Map();
  const processing = new Map();
  const reconciliationDue = new Map();
  let closed = false;
  let timer;
  let immediateScan = false;
  let store;
  const gateway = createConversationGateway(
    configDir,
    () => store?.gatewayKey,
    invoke,
  );

  function bindBackend(
    backend,
    getAdapter,
    projectThread = (thread) => thread,
  ) {
    const runtimeId = runtimeIdentity(backend);
    for (const [id, entry] of backends)
      if (entry.backendId === backend.id) backends.delete(id);
    const entry = { backendId: backend.id, getAdapter, projectThread };
    backends.set(runtimeId, entry);
    wake();
    return {
      callConversationTool: (receiver, name, args) =>
        invoke(runtimeId, receiver, name, args, entry),
      conversationToolEndpoint: gateway.endpoint(runtimeId),
    };
  }

  function current(runtimeId, entry) {
    if (closed || !store || !entry || backends.get(runtimeId) !== entry)
      throw new Error("会话管理器连接已过期，请重试");
  }

  function participant(id, actor, recipientOnly = false) {
    const item = store.get(id);
    if (
      !item ||
      (!sameAddress(item.to, actor) &&
        (recipientOnly || !sameAddress(item.from, actor)))
    )
      throw new Error(
        recipientOnly
          ? "当前会话无法回复这条消息，请使用自己收到的原消息 ID。"
          : "当前会话无法访问这条消息",
      );
    return item;
  }

  async function discover(caller, callerEntry, args) {
    const scope = args.scope ?? "workspace";
    const directoryFilter = scope === "global" ? args.cwd : undefined;
    const project = (entry, thread) => {
      const { folderPath } = entry.projectThread(thread);
      return {
        path:
          folderPath || thread.cwd ? normalize(folderPath || thread.cwd) : "",
        id: folderPath ? null : thread.projectId,
      };
    };
    const workspace = project(callerEntry, caller);
    const sameWorkspace = (candidateRuntime, entry, thread) => {
      const candidate = project(entry, thread);
      return (
        (workspace.path && candidate.path === workspace.path) ||
        (caller.runtimeId === candidateRuntime &&
          workspace.id &&
          candidate.id === workspace.id)
      );
    };
    const results = await Promise.all(
      [...backends]
        .filter(([runtimeId]) => canRoute(caller.runtimeId, runtimeId))
        .map(async ([runtimeId, entry]) => {
          const adapter = entry.getAdapter();
          if (!adapter) return { threads: [], complete: false };
          const result = await adapter.listActive();
          const observed = Array.isArray(result) ? result : result.threads;
          const threads = observed
            .filter(
              (thread) =>
                !sameAddress(
                  { runtimeId, threadId: thread.threadId },
                  caller,
                ) &&
                (scope === "global" ||
                  sameWorkspace(runtimeId, entry, thread)) &&
                stringFilter(thread.title, args.title) &&
                (!directoryFilter || thread.cwd?.includes(directoryFilter)),
            )
            .map((thread) => ({
              ...publicThread({ ...thread, runtimeId }),
              status: statusOf(thread.status),
            }));
          return { threads, complete: result.complete ?? true };
        }),
    );
    current(caller.runtimeId, callerEntry);
    return {
      scope,
      threads: results.flatMap((result) => result.threads),
      complete: results.every((result) => result.complete),
    };
  }

  async function submit(sender, entry, adapter, callId, args) {
    const sending = args.action === "send";
    validateKeys(
      args,
      sending
        ? ["threadId", "body", "requestId"]
        : ["replyTo", "body", "requestId"],
    );
    const requestId = args.requestId ?? callId;
    if (
      !args.body ||
      typeof requestId !== "string" ||
      !requestId.trim() ||
      requestId.length > 160
    )
      throw new Error("发送和回复须提供正文及有效的请求 ID");
    if (!sending && !args.replyTo) throw new Error("回复须提供原消息 ID");
    const replyTo = sending ? null : args.replyTo;
    const recipient = sending
      ? decodeAddress(args.threadId)
      : participant(replyTo, sender, true).from;
    if (!canRoute(sender.runtimeId, recipient.runtimeId))
      throw new Error("请选择同一后端的会话标识");
    if (sameAddress(sender, recipient)) throw new Error("请选择另一个会话");
    const summarize = (item) => {
      if (
        !sameAddress(item.to, recipient) ||
        item.replyTo !== replyTo ||
        item.body !== args.body
      )
        throw new Error("请求 ID 已用于其他消息");
      return {
        messageId: item.id,
        requestId: item.requestId,
        status: publicStatus(item.status),
      };
    };
    const existing = store.existing(sender, requestId);
    if (existing) return summarize(existing);
    const source = await adapter.readThread(sender.threadId);
    if (!source) throw new Error("找不到发起工具调用的会话");
    current(sender.runtimeId, entry);
    const item = store.insert(
      requestId,
      replyTo,
      threadInfo(source, sender),
      threadInfo(recipient, recipient),
      args.body,
    );
    wake(recipient);
    return summarize(item);
  }

  async function invoke(runtimeId, context, name, input, boundEntry) {
    const entry = boundEntry ?? backends.get(runtimeId);
    current(runtimeId, entry);
    const adapter = entry?.getAdapter();
    if (!adapter || typeof context?.threadId !== "string" || !context.threadId)
      throw new Error("会话工具需要已就绪的原生会话");
    const args = conversationArguments(name, input);
    const actor = { runtimeId, threadId: context.threadId };
    if (name === "list_active_threads") {
      const caller = await adapter.readThread(actor.threadId);
      if (!caller) throw new Error("找不到发起工具调用的会话");
      current(runtimeId, entry);
      return discover({ ...caller, ...actor }, entry, args);
    }
    if (args.action === "send" || args.action === "reply")
      return submit(actor, entry, adapter, context.callId, args);
    if (args.action === "status") {
      validateKeys(args, ["messageId"]);
      if (!args.messageId) throw new Error("查询状态须提供消息 ID");
      const item = participant(args.messageId, actor);
      return {
        ...view(item),
        replies: store.replies(item.id).map(view),
      };
    }
    validateKeys(args, ["cursor", "limit"]);
    const limit = args.limit ?? 20;
    const cursor =
      args.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(args.cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= 0)
      throw new Error("收件箱游标无效");
    const records = store.inbox(actor, cursor, limit + 1);
    return {
      messages: records.slice(0, limit).map(view),
      nextCursor:
        records.length > limit ? String(records[limit - 1].sequence) : null,
    };
  }

  async function dispatch(runtimeId, entry, threadId, items, state) {
    const ordered = items.toSorted(
      (first, second) => replyPriority(second) - replyPriority(first),
    );
    let blockedSubmission = false;
    for (const item of ordered) {
      const adapter = entry.getAdapter();
      if (
        closed ||
        state.rescan ||
        backends.get(runtimeId) !== entry ||
        !adapter
      )
        return;
      const submitting = item.status === "accepted";
      const scheduled = reconciliationDue.get(item.id);
      if (submitting ? blockedSubmission : scheduled?.at > Date.now()) continue;
      let outcome;
      try {
        if (submitting) {
          const target = await adapter.readThread(threadId);
          if (
            closed ||
            state.rescan ||
            backends.get(runtimeId) !== entry ||
            entry.getAdapter() !== adapter
          )
            return;
          if (!target) {
            store.update(item.id, "failed", {
              reason: "目标会话已关闭或无法接收消息",
            });
            continue;
          }
          item.to = threadInfo(target, { runtimeId, threadId });
          store.claim(item);
        }
      } catch (error) {
        store.update(item.id, "accepted", { reason: error.message });
        blockedSubmission = true;
        continue;
      }
      try {
        outcome = await (submitting
          ? adapter.deliver(item)
          : adapter.reconcile(item, item.receipt));
        if (!receiptStates.has(outcome?.status))
          throw new Error("运行时投递回执无效");
      } catch (error) {
        outcome = {
          status: submitting ? "unknown" : item.status,
          reason: error.message,
        };
      }
      const { status, ...receipt } = outcome;
      if (status === "deferred") {
        reconciliationDue.delete(item.id);
        store.update(item.id, "accepted", receipt);
        blockedSubmission = true;
        continue;
      }
      if (status === "queued" || status === "unknown") {
        const interval = scheduled
          ? Math.min(Math.max(retryMs, 60000), scheduled.interval * 2)
          : retryMs;
        reconciliationDue.set(item.id, { interval, at: Date.now() + interval });
      } else reconciliationDue.delete(item.id);
      store.update(item.id, status, {
        ...(!submitting && item.receipt),
        ...receipt,
        ...(status === "queued" && {
          queuedAt: item.receipt.queuedAt || new Date().toISOString(),
        }),
        ...(item.receipt.evidence &&
          receipt.evidence && {
            evidence: { ...item.receipt.evidence, ...receipt.evidence },
          }),
      });
    }
  }

  function scan() {
    timer = undefined;
    immediateScan = false;
    if (closed || !store) return;
    let pending = false;
    for (const [runtimeId, entry] of backends) {
      const targets = Map.groupBy(
        store.pending(runtimeId),
        (record) => record.to.threadId,
      );
      if (targets.size) pending = true;
      if (!entry.getAdapter()) continue;
      for (const [target, items] of targets) {
        const key = dispatchKey({ runtimeId, threadId: target });
        if (processing.has(key)) continue;
        const state = { rescan: false, job: null };
        processing.set(key, state);
        state.job = dispatch(runtimeId, entry, target, items, state)
          .catch(reportError)
          .finally(() => {
            processing.delete(key);
            if (state.rescan) wake();
          });
      }
    }
    if (pending && !immediateScan) {
      timer = setTimeout(scan, retryMs);
      timer.unref();
    }
  }

  function wake(recipient) {
    if (closed || !store) return;
    const state = recipient && processing.get(dispatchKey(recipient));
    if (state) {
      state.rescan = true;
      return;
    }
    if (immediateScan) return;
    clearTimeout(timer);
    immediateScan = true;
    timer = setTimeout(scan, 0);
    timer.unref();
  }

  return {
    bindBackend,
    wake,
    wakeThread(backendId, threadId) {
      for (const [runtimeId, entry] of backends)
        if (entry.backendId === backendId) wake({ runtimeId, threadId });
    },
    async start() {
      try {
        await gateway.start();
        store = await openConversationStore(
          join(configDir, "conversation-manager"),
        );
      } catch (error) {
        await gateway.close();
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        await Promise.allSettled(
          [...processing.values()].map(({ job }) => job),
        );
      } finally {
        store?.close();
        await gateway.close();
      }
    },
  };
}
