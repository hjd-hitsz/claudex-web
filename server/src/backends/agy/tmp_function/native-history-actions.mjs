// ACP 缺口：agy 1.5.18 的 session/rename、session/set_title、session/archive、
// session/unarchive 和 session/delete 返回 -32601 Method not found。
// 探测证据：ACP 与 CLI 读取标题 annotation；archived annotation 在两种列表
// 中仍可见。移走会话数据库后 ACP 隐藏该会话，移回后恢复。
// 切换条件：验证 ACP 改名、归档/恢复及删除可跨进程回读后迁移暂存会话，
// 见 docs/future_plan.md「改名、归档、删除同步到原生历史」。
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  executing,
  currentResultNotice,
} from "../../delegation/delegation-store.mjs";
import { nowSeconds } from "../session-store.mjs";
import {
  annotationTitle,
  nativePath,
  verifyNativeConversation,
  withoutCliSummary,
  withoutJetboxSummary,
} from "./native-history-index.mjs";
import {
  lockNativeHistory,
  nativeHistoryRoot,
  recoverNativeHistory,
  transactNativeHistory,
} from "./native-history-transaction.mjs";

const realAgent = "Antigravity ACP Server";
const actions = {
  "thread/name/set": ["name", "thread/name/updated"],
  "thread/archive": ["archived", "thread/archived"],
  "thread/unarchive": ["archived", "thread/unarchived"],
  "thread/delete": ["deleted", "thread/deleted"],
};
export const hasAgyHistoryAction = (method) => Object.hasOwn(actions, method);

export function assertHistoryIdle(method, session, data, work) {
  const { id } = session;
  if (work.pending) throw new Error("此对话有排队输入，请等待发送完成");
  if (
    work.active ||
    session.turns.some(({ status }) => status === "inProgress")
  )
    throw new Error("请先等待 agy 轮次结束");
  if (work.compacting || work.undoing)
    throw new Error("请先等待此对话的维护操作完成");
  if (method === "thread/name/set") return;
  if (
    Object.values(data.tasks).some(
      (task) =>
        task.parentId === id &&
        (executing.has(task.status) || task.status === "unknown"),
    )
  )
    throw new Error("请先等待或停止此对话的委派任务");
  if (
    work.delivering ||
    Object.values(data.notices).some(
      (notice) =>
        notice.parentId === id &&
        ["queued", "submitting"].includes(notice.status) &&
        currentResultNotice(data, notice),
    )
  )
    throw new Error("请等待此对话的委派结果回投完成");
}

async function assertBackgroundIdle(data, id, readExecutorBackground) {
  const delegates = Object.values(data.tasks).filter(
    (task) => task.parentId === id && task.executor?.threadId,
  );
  const results = await Promise.allSettled(
    delegates.map(readExecutorBackground),
  );
  for (const result of results) {
    if (result.status === "rejected")
      throw new Error("暂时无法核对该对话的后台终端", { cause: result.reason });
    const { terminals, jobs } = result.value;
    if (
      terminals.length ||
      jobs.some(
        (job) =>
          job.status === "running" ||
          ["pending", "preparing", "sending", "uncertain"].includes(
            job.delivery,
          ),
      )
    )
      throw new Error("请等待或停止此对话的后台终端");
  }
}

async function nativePlan(directory, nativeId, method, title) {
  const db = "conversations/" + nativeId + ".db";
  const parkedDir = nativeHistoryRoot + "/archived";
  const parked = parkedDir + "/" + nativeId + ".db";
  const live = nativePath(directory, db);
  const archive = nativePath(directory, parked);
  if (live && archive) throw new Error("agy 原生会话同时存在于历史和归档目录");
  if (live || archive)
    verifyNativeConversation(directory, live ? db : parked, nativeId);
  const annotation = "annotations/" + nativeId + ".pbtxt";
  const moves = [];
  const files = [];
  if (method === "thread/name/set") {
    if (!live && !archive) throw new Error("找不到 agy 原生会话数据库");
    await mkdir(join(directory, "annotations"), {
      recursive: true,
      mode: 0o700,
    });
    const path = nativePath(directory, annotation);
    const before = path && (await readFile(path));
    files.push({
      path: annotation,
      before,
      after: annotationTitle(before ?? Buffer.alloc(0), title),
    });
  } else if (method === "thread/archive") {
    if (live) {
      await mkdir(join(directory, parkedDir), { recursive: true, mode: 0o700 });
      nativePath(directory, parkedDir, "directory");
      moves.push({ from: db, to: parked, kind: "file" });
    }
  } else if (method === "thread/unarchive") {
    if (archive) moves.push({ from: parked, to: db, kind: "file" });
  } else {
    for (const [path, kind = "file"] of [
      [live ? db : parked],
      [annotation],
      ["chapter_titles/" + nativeId + ".pb"],
      ["voice_chats/" + nativeId + ".json"],
      ["brain/" + nativeId, "directory"],
    ]) {
      if (nativePath(directory, path, kind))
        moves.push({ from: path, to: "backup/removed-" + moves.length, kind });
    }
    for (const path of [
      "jetbox_summaries_proto.pb",
      "cache/conversation_metadata.json",
      "cache/last_conversations.json",
    ]) {
      const file = nativePath(directory, path);
      if (!file) continue;
      const before = await readFile(file);
      const after = path.endsWith(".pb")
        ? withoutJetboxSummary(before, nativeId)
        : withoutCliSummary(before, path, nativeId);
      if (!before.equals(after)) files.push({ path, before, after });
    }
  }
  return {
    files,
    moves,
    database: live ? db : parked,
    deleteSummary: method === "thread/delete",
  };
}

export function createAgyNativeHistoryActions({
  store,
  sessions,
  occupancy,
  readExecutorBackground,
  changed,
  directory = join(homedir(), ".gemini", "antigravity-cli"),
}) {
  let writes = Promise.resolve();
  async function update(method, session, params) {
    const [field, event] = actions[method];
    const value =
      field === "name"
        ? (params.name || "").trim()
        : method !== "thread/unarchive";
    const data = await store.read();
    const current = store.session(data, session.id);
    assertHistoryIdle(method, current, data, occupancy(session.id));
    if (method === "thread/delete")
      await assertBackgroundIdle(data, current.id, readExecutorBackground);
    await sessions.closeForHistory(current.id);
    const save = (key) =>
      store.change((fresh) => {
        const expected = store.session(fresh, current.id);
        assertHistoryIdle(method, expected, fresh, occupancy(current.id));
        if (expected.nativeId !== current.nativeId)
          throw new Error("agy 原生会话已切换");
        expected[field] = value;
        if (field === "archived") expected.updatedAt = nowSeconds();
        if (key) expected.nativeHistoryOperation = key;
      });
    const agent = sessions.agentInfo();
    if (current.nativeId && agent?.name === realAgent) {
      if (agent.version !== "1.5.18")
        throw new Error("当前 agy 版本的原生历史写入尚未验证");
      if (
        Object.values(data.sessions).some(
          ({ id, nativeId, deleted }) =>
            !deleted && id !== current.id && nativeId === current.nativeId,
        )
      )
        throw new Error("此 agy 原生会话同时关联了其他网页对话");
      const lock = await lockNativeHistory(directory, current.nativeId);
      try {
        const plan = await nativePlan(
          directory,
          current.nativeId,
          method,
          value,
        );
        await transactNativeHistory(directory, current, plan, save);
      } finally {
        await lock.close();
      }
    } else {
      await save();
    }
    changed(event, current.id, field === "name" ? value : undefined);
    return {};
  }
  return {
    async apply(method, session, params, data) {
      if (sessions.rewriting.has(session.id))
        throw new Error("正在更新 agy 对话历史，请稍后重试");
      assertHistoryIdle(method, session, data, occupancy(session.id));
      sessions.rewriting.add(session.id);
      const operation = writes.then(() => update(method, session, params));
      writes = operation.catch(() => {});
      try {
        return await operation;
      } finally {
        sessions.rewriting.delete(session.id);
      }
    },
    async recover() {
      if (sessions.agentInfo()?.name === realAgent)
        await recoverNativeHistory(directory, (await store.read()).sessions);
    },
  };
}
