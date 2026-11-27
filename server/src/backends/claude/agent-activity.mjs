/**
 * @param {import("./execution-types.d.mts").SaveSession} save
 * @param {import("./execution-types.d.mts").SessionDependencies["emit"]} emit
 */
export function createClaudeAgentActivity(save, emit) {
  /**
   * @param {string} threadId
   * @param {{agentId: string, parentNativeId: string, agentType?: string,
   *   toolUseId?: string, name?: string, prompt?: string, turnId: string,
   *   kind: "started" | "completed"}} activity
   */
  return async function recordAgentActivity(
    threadId,
    {
      agentId,
      parentNativeId,
      agentType,
      toolUseId,
      name,
      prompt,
      turnId,
      kind,
    },
  ) {
    const agentThreadId = `agent/${threadId}/${agentId}`;
    const id = `agent-${agentId}`;
    let item;
    await save(threadId, (session) => {
      const previous = session.agents?.[agentThreadId];
      const previousItem = session.extraItems?.[id];
      const call = session.agentCalls?.[toolUseId];
      // 整理可发出临时摘要代理的 Stop。只有已登记的子代理能结束。
      if (
        kind === "completed" &&
        !previous?.turnId &&
        !previous?.toolUseId &&
        previousItem?.kind !== "started"
      )
        return session;
      const owner =
        call?.turnId ?? previous?.turnId ?? previousItem?.turnId ?? turnId;
      const details = {
        ...previous,
        ...call,
        agentId,
        parentNativeId,
        turnId: owner,
        name: call?.name || name || previous?.name || agentType || "子代理",
        agentType: agentType ?? previous?.agentType,
        toolUseId: toolUseId ?? previous?.toolUseId,
        initialTask: prompt || call?.initialTask || previous?.initialTask,
      };
      item = {
        id,
        turnId: owner,
        type: "subAgentActivity",
        kind: previousItem?.kind === "completed" ? "completed" : kind,
        agentThreadId,
        agentPath: details.name,
        prompt: details.initialTask,
      };
      return {
        ...session,
        agents: { ...session.agents, [agentThreadId]: details },
        extraItems: { ...session.extraItems, [id]: item },
      };
    });
    if (item) emit("item/completed", { threadId, turnId: item.turnId, item });
  };
}
