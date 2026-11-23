import { randomUUID } from "node:crypto";
export function createOpenCodeGoals({ sdk, sessions, notify, active }) {
  const read = async (id) => (await sessions.record(id)).goal || null;
  async function change(id, patch, expected) {
    let changed = false;
    const { goal = null } = await sessions.update(id, (record) => {
      if (
        (!record.goal && !patch.id) ||
        (expected && record.goal?.id !== expected)
      )
        return {};
      changed = true;
      return {
        goal: { ...record.goal, ...patch, updatedAt: Date.now() / 1000 },
      };
    });
    if (changed) notify("thread/goal/updated", { threadId: id, goal });
    return goal;
  }
  async function kick(id) {
    const goal = await read(id);
    if (goal?.status !== "active") return;
    if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
      await change(id, { status: "budgetLimited", activeSince: null }, goal.id);
      return;
    }
    await sdk().sessions.synthetic({
      sessionID: await sessions.nativeId(id),
      text: `继续完成目标：${goal.objective}。完成后调用 claudex_goal_status 报告 complete；需要外部输入时报告 blocked，并说明具体原因。`,
      description: "目标续跑",
      metadata: { claudexGoalId: goal.id },
      delivery: "queue",
      resume: true,
    });
  }
  async function request(method, p) {
    if (method === "thread/goal/get") return { goal: await read(p.threadId) };
    if (method === "thread/goal/clear") {
      await sessions.update(p.threadId, { goal: null });
      await cancelPending(p.threadId);
      notify("thread/goal/updated", { threadId: p.threadId, goal: null });
      return { goal: null };
    }
    if (method !== "thread/goal/set") return;
    const previous = await read(p.threadId);
    const objective = (p.objective ?? previous?.objective ?? "").trim();
    if (!objective) throw new Error("请填写目标");
    const tokenBudget =
      p.tokenBudget === undefined
        ? (previous?.tokenBudget ?? null)
        : p.tokenBudget;
    if (
      tokenBudget !== null &&
      (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
    )
      throw new Error("Token 预算须为正整数");
    if (p.status && !["active", "paused"].includes(p.status))
      throw new Error("目标状态无效");
    const native = await sdk().sessions.get({
      sessionID: await sessions.nativeId(p.threadId),
    });
    const tokens =
      native.tokens.input +
      native.tokens.output +
      native.tokens.reasoning +
      (native.tokens.cache?.read || 0) +
      (native.tokens.cache?.write || 0);
    const goal = await change(p.threadId, {
      id: previous?.id || randomUUID(),
      objective,
      tokenBudget,
      status: p.status || "active",
      createdAt: previous?.createdAt || Date.now() / 1000,
      tokensUsed: previous?.tokensUsed || 0,
      timeUsedSeconds: previous?.timeUsedSeconds || 0,
      baseline: tokens - (previous?.tokensUsed || 0),
      activeSince:
        previous?.activeSince ||
        (p.status === "paused" ? null : Date.now() / 1000),
      origin: p.origin || "user",
    });
    if (goal.status === "active" && !active.has(p.threadId))
      await kick(p.threadId);
    if (goal.status === "paused") {
      await cancelPending(p.threadId);
      await sdk().sessions.interrupt({
        sessionID: await sessions.nativeId(p.threadId),
        resume: false,
      });
    }
    return { goal };
  }
  const plugin = {
    id: "claudex.goals",
    async setup(ctx) {
      const registrations = [];
      registrations.push(
        await ctx.tool.transform((editor) =>
          editor.add({
            name: "claudex_goal_status",
            options: { codemode: false },
            description:
              "Report completion or a concrete blocker for an explicitly configured Claudex goal. Only report complete after verifying its objective.",
            input: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["complete", "blocked"] },
                reason: { type: "string" },
              },
              required: ["status", "reason"],
              additionalProperties: false,
            },
            async execute(input, context) {
              const id = await sessions.logicalId(context.sessionID);
              const goal = await read(id);
              if (goal?.status !== "active") throw new Error("No active goal");
              await change(
                id,
                {
                  status: input.status === "complete" ? "completed" : "blocked",
                  error: input.status === "blocked" ? input.reason : null,
                },
                goal.id,
              );
              return { content: input.reason };
            },
          }),
        ),
      );
      registrations.push(
        await ctx.session.hook("context", async (event) => {
          const goal = await read(await sessions.logicalId(event.sessionID));
          if (goal?.status === "active")
            event.system.push({
              type: "text",
              text: `Claudex active goal: ${goal.objective}. Continue until it is verified complete or a concrete external blocker requires input. Use claudex_goal_status to report the result.`,
            });
        }),
      );
      registrations.push(
        await ctx.session.hook("experimental.idle", async (event) => {
          const id = await sessions.logicalId(event.sessionID);
          const goal = await read(id);
          if (goal?.status !== "active") return;
          const native = await ctx.session.get({ sessionID: event.sessionID });
          const t = native.tokens;
          const tokensUsed =
            t.input +
            t.output +
            t.reasoning +
            (t.cache?.read || 0) +
            (t.cache?.write || 0) -
            goal.baseline;
          await change(
            id,
            {
              tokensUsed,
              ...(goal.tokenBudget !== null &&
                tokensUsed >= goal.tokenBudget && { status: "budgetLimited" }),
            },
            goal.id,
          );
          if (!event.background.length && (await read(id))?.status === "active")
            await ctx.session.synthetic({
              sessionID: event.sessionID,
              text: `继续完成目标：${goal.objective}。完成后调用 claudex_goal_status。`,
              description: "目标续跑",
              metadata: { claudexGoalId: goal.id },
              delivery: "queue",
            });
        }),
      );
      return async () => {
        for (const r of registrations) await r.dispose();
      };
    },
  };
  async function settled(id, type) {
    const goal = await read(id);
    if (!goal) return;
    await usage(id);
    if (goal.activeSince)
      await change(
        id,
        {
          timeUsedSeconds:
            goal.timeUsedSeconds +
            Math.max(0, Date.now() / 1000 - goal.activeSince),
          activeSince: null,
        },
        goal.id,
      );
    if ((await read(id))?.status === "active" && !type.endsWith("succeeded"))
      await change(
        id,
        {
          status: type.endsWith("interrupted") ? "paused" : "blocked",
          error: type.endsWith("failed")
            ? "OpenCode 执行失败，请查看本轮错误后继续。"
            : null,
        },
        goal.id,
      );
  }
  async function cancelPending(id) {
    const sessionID = await sessions.nativeId(id);
    for (const input of await sdk().sessions.inbox.list({ sessionID }))
      if (input.type === "synthetic" && input.payload.metadata?.claudexGoalId)
        await sdk().sessions.inbox.cancel({ sessionID, inboxID: input.id });
  }
  async function usage(id) {
    const goal = await read(id);
    if (!goal || !goal.activeSince) return;
    const native = await sdk().sessions.get({
      sessionID: await sessions.nativeId(id),
    });
    const t = native.tokens;
    const tokensUsed = Math.max(
      0,
      t.input +
        t.output +
        t.reasoning +
        t.cache.read +
        t.cache.write -
        goal.baseline,
    );
    const exhausted =
      goal.status === "active" &&
      goal.tokenBudget !== null &&
      tokensUsed >= goal.tokenBudget;
    await change(
      id,
      {
        tokensUsed,
        ...(exhausted && { status: "budgetLimited" }),
      },
      goal.id,
    );
    if (exhausted) {
      await cancelPending(id);
      await sdk().sessions.interrupt({ sessionID: native.id, resume: false });
    }
  }
  return { request, plugin, settled, usage };
}
