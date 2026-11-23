export function createOpenCodeEvents({
  sdk,
  sessions,
  active,
  compactions,
  questions,
  notify,
  publish,
  settled,
  usage,
}) {
  const plans = new Map();
  async function refresh(threadId, finished = false) {
    const turns = await sessions.turns(threadId);
    const turn = turns.at(-1);
    if (!turn) return;
    if (!finished) active.set(threadId, turn.id);
    for (const item of turn.items)
      notify("item/completed", { threadId, turnId: turn.id, item });
    if (finished) notify("turn/completed", { threadId, turn });
  }
  async function event(event) {
    const data = event.data || {};
    if (event.type === "form.created") return questions.add(data.form, "form");
    if (event.type === "permission.asked")
      return questions.add(data, "permission");
    if (
      ["form.replied", "form.cancelled", "permission.replied"].includes(
        event.type,
      )
    )
      return questions.remove(data.formID || data.requestID || data.id);
    if (!data.sessionID) return;
    const threadId = await sessions.logicalId(data.sessionID);
    if (event.type === "session.created") {
      notify("thread/started", { thread: await sessions.read(threadId) });
      return;
    }
    if (event.type === "session.agent.selected")
      plans.set(threadId, data.agent === "plan");
    if (event.type === "session.execution.started") {
      await refresh(threadId);
      if (active.has(threadId))
        notify("turn/started", {
          threadId,
          turn: { id: active.get(threadId), status: "inProgress", items: [] },
        });
    }
    if (event.type.startsWith("session.inbox.")) {
      notify("lan/inputQueue/updated", { threadId });
      if (event.type === "session.inbox.delivered") await refresh(threadId);
    }
    const turnId = active.get(threadId);
    if (
      /^session\.(text|reasoning)\.(started|delta|ended)$/.test(event.type) &&
      turnId
    ) {
      const reasoning = event.type.includes("reasoning");
      const type = reasoning
        ? "reasoning"
        : plans.get(threadId)
          ? "plan"
          : "agentMessage";
      const itemId = `${data.assistantMessageID}:${data.ordinal}`;
      if (event.type.endsWith(".delta"))
        notify(
          reasoning ? "item/reasoning/summaryTextDelta" : `item/${type}/delta`,
          { threadId, turnId, itemId, delta: data.delta, summaryIndex: 0 },
        );
      else
        notify(
          event.type.endsWith(".started") ? "item/started" : "item/completed",
          {
            threadId,
            turnId,
            item: {
              id: itemId,
              type,
              ...(reasoning
                ? {
                    summary: [{ type: "summary_text", text: data.text || "" }],
                    content: [],
                  }
                : { text: data.text || "", phase: "commentary" }),
            },
          },
        );
    }
    if (
      /^session\.(tool|step)\./.test(event.type) &&
      !event.type.endsWith(".delta")
    )
      await refresh(threadId);
    if (event.type === "session.compaction.started")
      compactions.update(threadId, {
        id: data.inputID || event.id,
        status: "running",
        startedAt: event.created / 1000,
      });
    if (
      ["session.compaction.ended", "session.compaction.failed"].includes(
        event.type,
      )
    )
      compactions.finish(
        threadId,
        event.type.endsWith("ended") ? "completed" : "failed",
        data.error?.message,
      );
    if (
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
    ) {
      active.delete(threadId);
      await refresh(threadId, true);
      await settled(threadId, event.type);
    }
    if (event.type === "session.usage.updated") {
      await usage(threadId);
      notify("thread/tokenUsage/updated", {
        threadId,
        tokenUsage: (await sessions.read(threadId)).tokenUsage,
      });
    }
    publish();
  }
  return { event, refresh, plans };
}
