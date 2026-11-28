import {
  getSessionMessages,
  importSessionToStore,
  InMemorySessionStore,
} from "@anthropic-ai/claude-agent-sdk";

// SDK 负责记录发现、解析及消息链选择；临时原生快照补回 SessionMessage 省略的生命周期字段。
export async function nativeTranscripts(operation, args) {
  const store = new InMemorySessionStore();
  const keys = new Map();
  const append = store.append.bind(store);
  store.append = (key, entries) => {
    keys.set(JSON.stringify(key), key);
    return append(key, entries);
  };
  const subagent = operation === "getSubagentMessages";
  await importSessionToStore(args[0], store, {
    ...args[subagent ? 2 : 1],
    includeSubagents: subagent,
  });
  const selected = [...keys.values()].filter((key) =>
    subagent
      ? key.subpath?.split("/").at(-1) === `agent-${args[1]}`
      : !key.subpath,
  );
  if (!selected.length)
    throw new Error("Claude 原生会话记录不存在，请刷新历史后重试");
  return selected.map((key) => ({ key, entries: store.getEntries(key) }));
}

function byUuid(entries) {
  return new Map(
    entries.filter((entry) => entry.uuid).map((entry) => [entry.uuid, entry]),
  );
}

function enrich(raw, messages) {
  return messages.map((message) => ({ ...raw.get(message.uuid), ...message }));
}

export async function enrichSessionMessages(operation, args, messages) {
  const transcripts = await nativeTranscripts(operation, args);
  return enrich(
    byUuid(transcripts.flatMap(({ entries }) => entries)),
    messages,
  );
}

export async function readSessionTranscript(sessionId, options) {
  const [{ key, entries }] = await nativeTranscripts("getSessionMessages", [
    sessionId,
    options,
  ]);
  const raw = byUuid(entries);
  const transcript = new InMemorySessionStore();
  // 展示历史沿逻辑父节点跨越整理边界，保留片段沿原位置由 SDK 投影。
  await transcript.append(
    key,
    entries.map((entry) => {
      if (
        entry.subtype !== "compact_boundary" ||
        !raw.has(entry.logicalParentUuid)
      )
        return entry;
      const { preservedSegment, preservedMessages, ...compactMetadata } =
        entry.compactMetadata || {};
      return { ...entry, parentUuid: entry.logicalParentUuid, compactMetadata };
    }),
  );
  return enrich(
    raw,
    await getSessionMessages(sessionId, {
      ...options,
      sessionStore: transcript,
    }),
  );
}

// 按 CLI 规则读取最后一条目标状态；sentinel 区分显式设置、清除及原生评估结果。
export async function readNativeGoalStatus(sessionId, options) {
  const transcripts = await nativeTranscripts("getSessionMessages", [
    sessionId,
    options,
  ]);
  const records = transcripts.flatMap(({ entries }) => entries);
  const entry = records.findLast(
    (entry) =>
      entry.type === "attachment" && entry.attachment?.type === "goal_status",
  );
  const failure =
    entry &&
    records
      .slice(records.indexOf(entry) + 1)
      .findLast(
        (record) =>
          record.type === "attachment" &&
          ["hook_non_blocking_error", "hook_error_during_execution"].includes(
            record.attachment?.type,
          ) &&
          record.attachment.hookEvent === "Stop" &&
          record.attachment.command === entry.attachment.condition,
      );
  return entry
    ? {
        ...entry.attachment,
        nativeRecordId: entry.uuid,
        nativeTimestamp: entry.timestamp,
        ...(failure && {
          evaluationError: {
            ...failure.attachment,
            nativeRecordId: failure.uuid,
            nativeTimestamp: failure.timestamp,
          },
        }),
      }
    : null;
}
