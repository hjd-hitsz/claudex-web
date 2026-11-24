import React, { useContext, useMemo } from "react";
import { TerminalSquare, Users } from "lucide-react";
import { isActiveSubAgent, subAgents } from "../../domain/sub-agents.js";
import { BackgroundTasks } from "../background-tasks/background-task-provider.jsx";

export function ComposerActivity({ items, expanded, onToggle }) {
  const backgroundTaskCount = useContext(BackgroundTasks).tasks.length;
  const agentCount = useMemo(
    () => subAgents(items).filter(isActiveSubAgent).length,
    [items],
  );
  return [
    { title: "后台终端", count: backgroundTaskCount, Icon: TerminalSquare },
    { title: "活跃子代理", count: agentCount, Icon: Users },
  ].map(({ title, count, Icon }) =>
    count > 0 ? (
      <button
        key={title}
        type="button"
        className={
          "icon-button composer-activity-count" + (expanded ? " active" : "")
        }
        aria-label={`${title}，${count} 个运行中`}
        title={title}
        aria-expanded={expanded}
        aria-controls="conversation-context"
        onClick={onToggle}
      >
        <Icon size={16} aria-hidden="true" />
        <span>{count}</span>
      </button>
    ) : null,
  );
}
