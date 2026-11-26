import React from "react";
import { openSubAgent, useStoreSelector } from "../../store.js";
import { delegationLabels } from "../../domain/delegation.js";
import { subAgents } from "../../domain/sub-agents.js";
import { DelegationContext } from "./delegation-context.jsx";
import { DeliverySummary } from "./delivery-summary.jsx";

export function DelegationResult({ item, readOnly }) {
  const tasks = useStoreSelector((state) => state.items);
  const matches = subAgents(tasks).filter(
    ({ delegation }) => delegation?.taskId.slice(0, 8) === item.taskId,
  );
  const [agent] = matches.length === 1 ? matches : [];
  const stepId = item.stepId ?? item.id.split(":result")[0].slice(0, 8);
  const summary = agent?.delegation.summaries?.[stepId];
  const backend = item.target === "codex" ? "Codex" : "Claude Code";
  const status =
    item.status === "completed" ? "已完成" : delegationLabels[item.status];
  return (
    <div className="delegation-result" data-delegation-task={item.taskId}>
      <DeliverySummary
        title={summary?.title || "委派结果"}
        status={backend + " · " + (status || "待核对")}
        preview={summary?.preview ?? item.preview}
        action="查看执行记录"
        onOpen={agent && !readOnly ? () => openSubAgent(agent) : undefined}
      />
      <DelegationContext context={item.context} />
    </div>
  );
}
