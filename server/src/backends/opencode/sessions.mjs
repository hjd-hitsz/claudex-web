import { allMessages, historyTurns, page, tokenUsage } from "./messages.mjs";
import { conversationMethods } from "../../../../shared/product-contract.mjs";
import { resolve } from "node:path";
import { speedVariant, sessionModelSettings } from "./model-settings.mjs";

export function createOpenCodeSessions({
  sdk,
  storage,
  active,
  notify,
  config,
}) {
  const removed = new Set();
  async function record(id) {
    return (await storage.read()).sessions[id] || { nativeId: id };
  }
  async function update(id, patch) {
    const data = await storage.update((data) => ({
      ...data,
      sessions: {
        ...data.sessions,
        [id]: {
          ...data.sessions[id],
          ...(typeof patch === "function"
            ? patch(data.sessions[id] || {})
            : patch),
        },
      },
    }));
    return data.sessions[id];
  }
  async function nativeId(id) {
    return (await record(id)).nativeId || id;
  }
  async function logicalId(id) {
    const entries = Object.entries((await storage.read()).sessions);
    return entries.find(([, s]) => s.nativeId === id)?.[0] || id;
  }
  async function thread(native, id = native.id) {
    return {
      id,
      name: native.title,
      preview: native.title || "新对话",
      cwd: native.location.directory,
      model: native.model
        ? `${native.model.providerID}/${native.model.id}`
        : "",
      providerId: "",
      createdAt: native.time.created / 1000,
      updatedAt: native.time.updated / 1000,
      status: { type: active.has(id) ? "active" : "idle" },
      path: native.time.archived ? "/archived_sessions/" : "",
      ...(native.parentID && {
        parentThreadId: await logicalId(native.parentID),
      }),
      tokenUsage: tokenUsage(native),
    };
  }
  async function turns(id) {
    const sessionID = await nativeId(id);
    const messages = await allMessages(sdk(), sessionID);
    const records = historyTurns(messages, active.has(id));
    if (!messages.some((m) => m.snapshot?.files?.length)) return records;
    const native = await sdk().sessions.get({ sessionID });
    for (const turn of records) {
      const user = turn.items.find(
        (item) => item.type === "userMessage" && !item.authorLabel,
      );
      if (!user) continue;
      const changes = await sdk().sessions.diff({
        sessionID,
        from: user.id,
        to: user.id,
      });
      if (changes.length)
        turn.items.push({
          id: `files-${turn.id}`,
          type: "fileChange",
          status: turn.status === "inProgress" ? "inProgress" : "completed",
          changes: changes.map((change) => ({
            path: resolve(native.location.directory, change.file),
            kind: {
              type: { added: "add", deleted: "delete", modified: "update" }[
                change.status
              ],
            },
            diff: change.patch,
          })),
        });
    }
    return records;
  }
  async function read(id, includeTurns = false) {
    const native = await sdk().sessions.get({ sessionID: await nativeId(id) });
    const models = await sdk().model.list({ location: native.location });
    let cursor, last;
    do {
      const result = await sdk().message.list({
        sessionID: native.id,
        limit: 50,
        ...(cursor ? { cursor } : { order: "desc" }),
      });
      last = result.data.find((m) => m.type === "assistant" && m.tokens);
      cursor = result.cursor.next;
    } while (!last && cursor);
    return {
      ...(await thread(native, id)),
      ...sessionModelSettings(native.model, models.data),
      tokenUsage: tokenUsage(
        native,
        models.data.find(
          (m) =>
            m.id === native.model?.id &&
            m.providerID === native.model?.providerID,
        ),
        last,
      ),
      ...(includeTurns && { turns: await turns(id) }),
    };
  }
  async function fork(id, before) {
    return sdk().sessions.fork({
      sessionID: await nativeId(id),
      ...(before && { before }),
    });
  }
  async function response(native) {
    const { data } = await sdk().model.list({ location: native.location });
    const settings = sessionModelSettings(native.model, data);
    return { thread: { ...(await thread(native)), ...settings }, ...settings };
  }
  async function request(method, p) {
    const api = sdk().sessions;
    if (method === "thread/start") {
      const native = await api.create({
        location: { directory: p.cwd || config.defaultCwd },
        ...(p.model && {
          model: modelRef(p.model, p.reasoningEffort, p.serviceTier),
        }),
        ...(p.collaborationMode?.mode === "plan" && { agent: "plan" }),
      });
      await update(native.id, { nativeId: native.id });
      return response(native);
    }
    if (method === "thread/list") {
      const result = await api.list({
        limit: p.limit || 50,
        ...(p.cursor
          ? { cursor: p.cursor }
          : {
              archived: Boolean(p.archived),
              order: "desc",
              ...(p.searchTerm && { search: p.searchTerm }),
            }),
      });
      const sessions = (await storage.read()).sessions;
      const hidden = new Set(
        Object.values(sessions).flatMap((s) => s.aliases || []),
      );
      const data = await Promise.all(
        result.data
          .filter((n) => !hidden.has(n.id))
          .map(async (n) => thread(n, await logicalId(n.id))),
      );
      return { data, nextCursor: result.cursor.next || null };
    }
    if (["thread/read", "thread/resume"].includes(method)) {
      const thread = await read(p.threadId, p.includeTurns === true);
      return {
        thread,
        model: thread.model,
        reasoningEffort: thread.reasoningEffort,
        serviceTier: thread.serviceTier,
      };
    }
    if (method === "thread/unsubscribe") return {};
    if (method === "thread/turns/list") return page(await turns(p.threadId), p);
    if (method === "thread/items/list")
      return page(
        (await turns(p.threadId)).flatMap((turn) =>
          turn.items.map((item) => ({ turnId: turn.id, item })),
        ),
        p,
      );
    if (method === "thread/fork") {
      const records = await turns(p.threadId);
      const index = p.turnId
        ? records.findIndex((t) => t.id === p.turnId)
        : records.length - 1;
      if (p.turnId && index < 0) throw new Error("分支起点已变化");
      const native = await fork(
        p.threadId,
        records[index + 1]?.items.find((i) => i.type === "userMessage")?.id,
      );
      await update(native.id, { nativeId: native.id });
      return response(native);
    }
    if (["thread/revert", "thread/rollback"].includes(method)) {
      const records = await turns(p.threadId);
      const index = p.beforeTurnId
        ? records.findIndex((t) => t.id === p.beforeTurnId)
        : records.length - p.numTurns;
      if (!Number.isInteger(index) || index < 0 || index >= records.length)
        throw new Error("编辑起点已变化，请刷新后重试");
      const previous = await record(p.threadId);
      const native = await fork(
        p.threadId,
        records[index].items.find((i) => i.type === "userMessage").id,
      );
      await update(p.threadId, {
        nativeId: native.id,
        aliases: [...(previous.aliases || []), previous.nativeId || p.threadId],
      });
      notify("thread/reverted", { threadId: p.threadId });
      return {};
    }
    const sessionID = await nativeId(p.threadId);
    if (method === "thread/name/set")
      await api.update({ sessionID, title: p.name });
    else if (["thread/archive", "thread/unarchive"].includes(method))
      await api.update({ sessionID, archived: method === "thread/archive" });
    else if (method === "thread/delete") {
      removed.add(sessionID);
      try {
        await api.remove({ sessionID });
      } catch (error) {
        removed.delete(sessionID);
        throw error;
      }
    } else throw new Error(`OpenCode 会话操作无效：${method}`);
    return {};
  }
  return {
    removed,
    record,
    update,
    nativeId,
    logicalId,
    read,
    turns,
    request,
    handles: (method) => conversationMethods.includes(method),
  };
}
export function modelRef(value, effort, tier) {
  const separator = value.indexOf("/");
  if (separator < 1) throw new Error("请选择 OpenCode 供应商与模型");
  const variant = value.startsWith("openai/")
    ? speedVariant(effort, tier)
    : effort;
  return {
    providerID: value.slice(0, separator),
    id: value.slice(separator + 1),
    ...(variant && { variant }),
  };
}
