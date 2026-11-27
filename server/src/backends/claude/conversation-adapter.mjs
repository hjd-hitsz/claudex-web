import { formatConversationMessage } from "../../conversation-manager/message.mjs";
import { claudeConversationServerName } from "../../conversation-manager/tools.mjs";
import { nativeProcessesAlive } from "./process-ownership.mjs";
import { runningBackgroundTask } from "./background-tasks.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function managed(session) {
  return (
    session &&
    !session.deleted &&
    !session.archived &&
    (!session.initialized || session.nativeProcess)
  );
}

function descriptor(session) {
  return {
    threadId: session.id,
    title: session.name || "新对话",
    cwd: session.cwd,
  };
}

function receipt(status, messageUuid, source) {
  return { status, evidence: { messageUuid, source } };
}

function deliveryState(state, reason) {
  return { status: state, reason };
}

export function claudeConversationAdapter({
  storage,
  runtime,
  questions,
  compactions,
  files,
  readSession,
  assertReady,
}) {
  function status(s) {
    if ([...questions.values()].some((q) => q.threadId === s.id))
      return "waitingForInput";
    const process = runtime.queries.get(s.id);
    if (
      runtime.running.has(s.id) ||
      process?.commands.busy ||
      compactions.busy(s.id)
    )
      return "running";
    if (s.queue?.[0]?.status === "queued") return "queued";
    const tasks = Object.values(s.backgroundTasks || {});
    if (tasks.some(runningBackgroundTask)) return "background";
    if (s.queue?.length || tasks.some((task) => task.status === "unknown"))
      return "unknown";
    return null;
  }

  async function previousProcessAlive(s) {
    return !runtime.queries.has(s.id) && Boolean(await nativeProcessesAlive(s));
  }

  async function reconcile(envelope) {
    assertReady();
    const s = (await storage.read()).sessions[envelope.to.threadId];
    const accepted = s?.peerInputs?.[envelope.id];
    if (accepted?.nativeAccepted)
      return receipt(
        "delivered",
        envelope.id,
        accepted.nativeReceipt || "claude-native-stream",
      );
    if (accepted?.rejected) return deliveryState("failed", accepted.rejected);
    const waiting = s?.queue?.find((entry) => entry.id === envelope.id);
    if (waiting?.status === "queued") {
      if (!runtime.running.has(s.id) && !(await previousProcessAlive(s)))
        runtime.resumeQueue(s.id);
      return receipt("queued", envelope.id, "claude-worker-queue");
    }
    if (waiting?.status === "uncertain")
      return deliveryState("unknown", "目标会话的排队输入已暂停。");
    const active = s && runtime.running.get(s.id);
    if (
      accepted &&
      (active?.turn.id === envelope.id ||
        active?.peerInputIds?.has(envelope.id))
    )
      return receipt("queued", envelope.id, "claude-worker-input");
    if (accepted && s.initialized && !s.deleted) {
      const records = await readSession(
        "getSessionMessages",
        accepted.nativeSessionId,
        {
          dir: s.historySearchAll ? undefined : accepted.cwd,
        },
      ).catch(() => []);
      if (
        records.some(
          (item) => item.type === "user" && item.uuid === envelope.id,
        )
      )
        return receipt("delivered", envelope.id, "claude-native-history");
    }
    return deliveryState("unknown", "尚无可核对的 Claude 原生输入回执。");
  }

  return {
    async observeThreads() {
      assertReady();
      const sessions = (await storage.read()).sessions;
      const threads = Object.values(sessions).flatMap((session) => {
        if (!managed(session)) return [];
        const state = status(session);
        return state
          ? [
              {
                ...descriptor(session),
                status: state,
                generating:
                  state === "running" && runtime.running.has(session.id),
                background: Object.values(session.backgroundTasks || {}).some(
                  runningBackgroundTask,
                ),
              },
            ]
          : [];
      });
      return {
        threads,
        complete: threads.every((session) => session.status !== "unknown"),
      };
    },
    async readThread(id) {
      assertReady();
      const session = (await storage.read()).sessions[id];
      if (!managed(session)) return null;
      const delegationTurnId =
        runtime.queries.get(id)?.secretaryRole &&
        runtime.running.get(id)?.turn?.id;
      return { ...descriptor(session), delegationTurnId };
    },
    async deliver(envelope) {
      assertReady();
      if (!uuid.test(envelope.id))
        return deliveryState("failed", "会话消息 ID 无效。");
      const sessions = (await storage.read()).sessions;
      const s = sessions[envelope.to.threadId];
      if (s?.peerInputs?.[envelope.id]) return reconcile(envelope);
      if (!managed(s))
        return deliveryState(
          "failed",
          "目标会话已关闭或不属于 Claudex 执行服务。",
        );
      const peer = { id: envelope.id, from: envelope.from };
      const input = [
        {
          type: "text",
          text: formatConversationMessage(
            envelope,
            claudeConversationServerName,
          ),
        },
      ];
      if (envelope.replyTo && runtime.running.has(s.id)) {
        const result = await runtime.steerPeer(
          s.id,
          peer,
          input,
          () => !files.undoing.has(s.id),
        );
        if (result === "queued")
          return receipt("queued", envelope.id, "claude-worker-input");
        if (result === "failed")
          return deliveryState("failed", "目标会话已关闭。");
      }
      const occupied = status(s);
      if (
        files.undoing.has(s.id) ||
        (occupied && occupied !== "background") ||
        (await previousProcessAlive(s))
      )
        return deliveryState("deferred", "Claude 会话尚有前序工作。");
      try {
        await runtime.enqueue(
          s.id,
          {
            input,
            collaborationMode: { mode: s.mode },
            effort: s.effort,
            serviceTier: s.serviceTier,
            review: s.review,
          },
          false,
          peer,
        );
      } catch (error) {
        if (error.code === "ECLAUDECONVERSATIONBUSY")
          return deliveryState("deferred", error.message);
        if (error.code === "ECLAUDECONVERSATIONCLOSED")
          return deliveryState("failed", error.message);
        throw error;
      }
      return receipt("queued", envelope.id, "claude-worker-queue");
    },
    reconcile,
  };
}
