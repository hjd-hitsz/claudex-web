import { flushAcpMessage } from "./acp-events.mjs";
import { applyAcpSelection } from "./acp-models.mjs";
import { agyTokenUsage } from "./context-usage.mjs";
import { nowSeconds } from "./session-store.mjs";
import { currentResultNotice } from "../delegation/delegation-store.mjs";
import { compileAgyPrompt } from "./acp-prompt.mjs";
import { startAgyPromptRun } from "./tmp_function/session-steer.mjs";

export function createAgyTurns({
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
  agentInfo,
  idle,
}) {
  async function prompt(session, record, input, blocks) {
    if (active.has(session.id)) throw new Error("agy 会话已有正在执行的轮次");
    const turn = {
      id: record.id,
      status: "inProgress",
      startedAt: nowSeconds(),
      items: record.items,
    };
    const done = Promise.withResolvers();
    const activity = {
      turn,
      input,
      session,
      ready: false,
      done: done.promise,
      controller: new AbortController(),
      announced: new Set(),
    };
    let ignored = false;
    active.set(session.id, activity);
    const notify = (method, params) =>
      emit({ method, params: { threadId: session.id, ...params } });
    activity.compaction = compactions.track(activity, notify);
    try {
      const role = await readRole();
      const { entry, repair } = await prepareSession(session, role, activity);
      if (
        input.nativeCommand &&
        !(await commands(entry)).some(
          ({ name }) => name === input.nativeCommand,
        )
      )
        throw new Error(
          `当前 Antigravity 会话未提供 /${input.nativeCommand}，请重新选择命令`,
        );
      await applyAcpSelection(entry, input, session);
      activity.compaction.prepare(entry.nativeId, agentInfo());
      const {
        promptBlocks,
        contextPending,
        checkpointPending,
        historyPending,
      } = await compileAgyPrompt(session, blocks, activity, repair, execution);
      const submitted = await store.change((data) => {
        if (activity.cancelled) return false;
        const notice = data.notices[record.noticeId];
        if (
          record.noticeId &&
          (notice?.status !== "queued" || !currentResultNotice(data, notice))
        )
          return false;
        const s = store.session(data, session.id);
        if (repair) {
          s.previousNativeId = session.nativeId;
          s.nativeContextPending = true;
        }
        s.nativeId = entry.nativeId;
        s.model = entry.config.model || s.model;
        s.effort = entry.config.effort || s.effort;
        s.turns.push(turn);
        if (record.noticeId) notice.status = "submitting";
        return true;
      });
      if (!submitted || activity.cancelled) {
        ignored = Boolean(record.noticeId && !submitted);
        turn.status = "interrupted";
        return { turn };
      }
      notify("turn/started", { turn });
      for (const item of turn.items) {
        activity.announced.add(item.id);
        notify("item/completed", { turnId: turn.id, item });
      }
      notify("thread/settings/updated", {
        threadSettings: {
          model: entry.config.model,
          reasoningEffort: entry.config.effort,
          collaborationMode: { mode: "default" },
        },
      });
      activity.entry = entry;
      activity.contextChanged =
        Boolean(repair) ||
        (session.model && entry.config.model !== session.model);
      activity.submitted = true;
      activity.run = startAgyPromptRun(entry, promptBlocks, (error) =>
        notify("error", {
          error: { message: "Antigravity 补充说明发送失败：" + error.message },
        }),
      );
      const result = await activity.run.done;
      activity.promptUsage = result.usage;
      activity.submitted = false;
      activity.historyAccepted =
        historyPending && result.stopReason === "end_turn";
      activity.contextAccepted =
        contextPending && result.stopReason !== "cancelled";
      activity.checkpointAccepted =
        checkpointPending &&
        !activity.cancelled &&
        result.stopReason === "end_turn";
      flushAcpMessage(activity, notify);
      const lastAction = turn.items.findLast(({ type }) =>
        ["agentMessage", "mcpToolCall", "fileChange"].includes(type),
      );
      if (lastAction?.type === "mcpToolCall" && lastAction.status === "failed")
        activity.error ||= `Antigravity 在工具「${lastAction.tool}」失败后结束了本轮。`;
      turn.status =
        activity.cancelled || result.stopReason === "cancelled"
          ? "interrupted"
          : activity.error
            ? "failed"
            : result.stopReason === "end_turn"
              ? "completed"
              : "failed";
      if (turn.status === "failed")
        turn.error = {
          message: activity.error || "agy 结束原因：" + result.stopReason,
        };
      if (record.noticeId) await execution.finishNotice(record.noticeId, turn);
    } catch (error) {
      flushAcpMessage(activity, notify);
      turn.status = activity.cancelled ? "interrupted" : "failed";
      if (!activity.cancelled) turn.error = { message: error.message };
    } finally {
      activity.submitted = false;
      try {
        if (!ignored) {
          if (activity.entry) toolResults?.([turn], [activity.entry.nativeId]);
          turn.completedAt = nowSeconds();
          const compaction = activity.compaction.finish();
          const tokenUsage = (turn.tokenUsage = agyTokenUsage(activity));
          await store.change((data) => {
            const s = store.session(data, session.id);
            const index = s.turns.findIndex(({ id }) => id === turn.id);
            if (index === -1) s.turns.push(turn);
            else s.turns[index] = turn;
            s.updatedAt = turn.completedAt;
            if (activity.contextAccepted) delete s.nativeContextPending;
            if (activity.historyAccepted) delete s.historyReplay;
            if (activity.checkpointAccepted && s.contextCheckpoint)
              s.contextCheckpoint.pending = false;
            if (!s.name && activity.title) s.name = activity.title;
            s.tokenUsage = tokenUsage;
          });
          for (const item of turn.items)
            if (!activity.announced.has(item.id))
              notify("item/completed", { turnId: turn.id, item });
          if (!session.name && activity.title)
            notify("thread/name/updated", { threadName: activity.title });
          if (compaction) activity.compaction.publish();
          notify("thread/tokenUsage/updated", {
            turnId: turn.id,
            tokenUsage,
          });
          notify("turn/completed", { turn });
        }
      } finally {
        active.delete(session.id);
        const entry = entries.get(session.id);
        if (entry) idle(session.id, entry);
        done.resolve();
      }
    }
    return { turn };
  }
  function cancelActive(id) {
    const activity = active.get(id);
    if (!activity || activity.cancelled) return;
    activity.cancelled = true;
    activity.controller.abort();
    activity.run?.cancel();
  }

  async function steer(session, expectedTurnId, item, input, blocks) {
    const { id } = session;
    const activity = active.get(id);
    const requireActive = () => {
      if (compactions.entries.get(id)?.status === "running")
        throw new Error("正在整理上下文，完成后可继续发送");
      if (
        !activity ||
        activity.turn.id !== expectedTurnId ||
        activity.cancelled
      )
        throw new Error(
          "当前轮次已结束或发生变化。补充说明仍在输入框，请确认后重新发送。",
        );
      if (!activity.run?.running)
        throw new Error(
          "Antigravity 此时无法接收补充说明。补充说明仍在输入框，可稍后重试。",
        );
    };
    requireActive();
    if (activity.steering)
      throw new Error("正在发送上一条补充说明，请稍后重试");
    activity.steering = true;
    try {
      const entry = entries.get(id);
      const promptBlocks = await execution.forwardingContext(id, blocks);
      requireActive();
      const { model, effort } = entry.config;
      await applyAcpSelection(entry, input, { model, effort });
      requireActive();
      const { turn } = activity;
      activity.run.steer(promptBlocks);
      activity.input.delegateTo = input.delegateTo;
      turn.items.push(item);
      activity.announced.add(item.id);
      const notify = (method, params) =>
        emit({ method, params: { threadId: id, ...params } });
      notify("item/completed", { turnId: turn.id, item });
      if (entry.config.model !== model || entry.config.effort !== effort)
        notify("thread/settings/updated", {
          threadSettings: {
            model: entry.config.model,
            reasoningEffort: entry.config.effort,
            collaborationMode: { mode: "default" },
          },
        });
      await store
        .change((data) => {
          const s = store.session(data, id);
          const saved = s.turns.find(({ id }) => id === turn.id);
          saved.items = turn.items;
          s.model = entry.config.model || s.model;
          s.effort = entry.config.effort || s.effort;
        })
        .catch((error) =>
          notify("error", {
            error: {
              message: "补充说明已发送，保存记录失败：" + error.message,
            },
          }),
        );
      return { turnId: turn.id };
    } finally {
      activity.steering = false;
    }
  }

  return { prompt, steer, cancelActive };
}
