import { SubAgentConversation } from "./subagent-conversation.jsx";
import { DelegationDetails } from "./delegation-details.jsx";
import { delegationLabels } from "../../domain/delegation.js";
import { BackgroundTaskOutput } from "../background-tasks/background-task-output.jsx";
import { BackgroundTaskList } from "../background-tasks/background-task-list.jsx";
import { BackgroundTasks } from "../background-tasks/background-task-provider.jsx";
import { GoalEditor } from "../commands/goal-editor.jsx";
import { useSurfaceResize } from "../../ui/surface-resize.jsx";
import React, {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Files,
  GitPullRequest,
  TerminalSquare,
  Users,
  X,
} from "lucide-react";
import { openSubAgent, set, useStore } from "../../store.js";
import {
  agentStatusLabels,
  contextAgentRows,
  subAgents,
} from "../../domain/sub-agents.js";
import { ChangesPanel } from "./changes-panel.jsx";
import { IconButton } from "../../ui/primitives.jsx";

const FilePanel = lazy(() =>
  import("./file-panel.jsx").then((module) => ({ default: module.FilePanel })),
);

export function ContextCard() {
  const s = useStore();
  const backgroundTasks = useContext(BackgroundTasks);
  const agents = contextAgentRows(s.items);
  return (
    <section className="context-card" aria-label="对话功能">
      <div className="context-card-heading">
        <strong>工作区</strong>
      </div>
      <nav aria-label="工作区工具">
        <button onClick={() => set({ panel: "files", contextOpen: true })}>
          <Files size={17} />
          <span>文件</span>
          <ChevronRight size={14} />
        </button>
        <button onClick={() => set({ panel: "changes", contextOpen: true })}>
          <GitPullRequest size={17} />
          <span>变更</span>
          <ChevronRight size={14} />
        </button>
        <button
          aria-pressed={s.terminalOpen}
          onClick={() => set({ terminalOpen: !s.terminalOpen })}
        >
          <TerminalSquare size={17} />
          <span>终端</span>
          <small>{s.terminalOpen ? "已打开" : "打开"}</small>
        </button>
      </nav>
      {(s.current?.backendId !== "agy" || backgroundTasks.tasks.length > 0) && (
        <BackgroundTaskList
          {...backgroundTasks}
          onSelect={(task) =>
            set({
              panel: "background-task",
              panelBackgroundTask: { ...task, threadId: s.current.id },
            })
          }
        />
      )}
      {agents.length > 0 && (
        <div className="context-agents">
          <div className="context-section-heading">
            <strong>子代理</strong>
            <small>{agents.length}</small>
          </div>
          <div className="context-agent-list">
            {agents.map(({ agent, title, identifier, tooltip }) => (
              <button
                key={agent.id}
                title={tooltip ?? title}
                onClick={() => openSubAgent(agent)}
              >
                <Users size={17} />
                <span>
                  <span className="context-agent-title">
                    <b>{title}</b>
                    {identifier && <code>{identifier}</code>}
                  </span>
                  <span className="context-agent-meta">
                    {agent.delegation && <small>{agent.name}</small>}
                    <small data-status={agent.status}>
                      {(agent.delegation && delegationLabels[agent.status]) ||
                        agentStatusLabels[agent.status] ||
                        "状态待更新"}
                    </small>
                  </span>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function ContextWorkspace({ toggleRef }) {
  const s = useStore();
  const [filesOpened, keepFiles] = useState(s.panel === "files");
  const detailsOpen = s.contextOpen === true;
  const resize = useSurfaceResize({
    id: "context",
    panel: true,
    active: detailsOpen && Boolean(s.panel),
  });
  const task =
    s.panelBackgroundTask?.threadId === s.current?.id
      ? s.panelBackgroundTask
      : null;
  const selectedAgent =
    s.panelAgent?.parentId === s.current?.id ? s.panelAgent : null;
  const agent = selectedAgent?.delegation
    ? subAgents(s.items).find(({ id }) => id === selectedAgent.id) ||
      selectedAgent
    : selectedAgent;
  useEffect(() => {
    if (s.panel === "files") keepFiles(true);
    if (s.panel === "agent" && !agent) set({ panel: null, panelAgent: null });
  }, [s.panel, agent]);
  return (
    <>
      <aside
        ref={resize.ref}
        id="conversation-context"
        className={"context-workspace " + (s.panel ? "showing-panel" : "")}
        data-open={detailsOpen}
        aria-label="对话详情"
      >
        {s.panel && resize.handle}
        {s.panel ? (
          <div
            className={
              "context-backbar" +
              (s.panel === "goal" ? " goal-panel-heading" : "")
            }
          >
            <button
              aria-label="返回概览"
              title="返回概览"
              onClick={() => set({ panel: null })}
            >
              <ArrowLeft size={15} />
              {s.panel !== "goal" && "返回概览"}
            </button>
            {s.panel === "goal" && <span>目标</span>}
            {s.panel === "background-task" && task && (
              <strong
                className="background-task-panel-title"
                title={task.title}
              >
                {task.title}
              </strong>
            )}
            <IconButton
              icon={X}
              title="收起对话详情"
              onClick={() => set({ contextOpen: false })}
            />
          </div>
        ) : (
          <ContextCard />
        )}
        {filesOpened && (
          <div
            className="context-panel file-workspace"
            style={{ display: s.panel === "files" ? "flex" : "none" }}
          >
            <Suspense fallback={<div className="loading">正在打开文件…</div>}>
              <FilePanel />
            </Suspense>
          </div>
        )}
        {s.panel === "goal" && s.current && <GoalEditor key={s.current.id} />}
        {s.panel === "background-task" && task && detailsOpen && (
          <BackgroundTaskOutput
            key={task.threadId + "/" + task.id}
            task={task}
          />
        )}
        {s.panel === "changes" && (
          <div className="context-panel">
            <ChangesPanel />
          </div>
        )}
        {s.panel === "agent" &&
          agent &&
          detailsOpen &&
          (agent.delegation ? (
            <DelegationDetails
              key={agent.id}
              agent={agent}
              parentId={s.current.id}
            />
          ) : (
            <SubAgentConversation
              key={s.current.id + ":" + agent.id}
              agent={agent}
            />
          ))}
      </aside>
      <nav
        className="context-tools"
        data-open={detailsOpen}
        aria-label="工作区快捷工具"
      >
        <IconButton
          icon={Files}
          title="文件"
          active={s.panel === "files"}
          aria-pressed={s.panel === "files"}
          onClick={() =>
            set(
              s.panel === "files" ? { contextOpen: false } : { panel: "files" },
            )
          }
        />
        <IconButton
          icon={GitPullRequest}
          title="变更"
          active={s.panel === "changes"}
          aria-pressed={s.panel === "changes"}
          onClick={() =>
            set(
              s.panel === "changes"
                ? { contextOpen: false }
                : { panel: "changes" },
            )
          }
        />
        <IconButton
          icon={TerminalSquare}
          title="终端"
          active={s.terminalOpen}
          aria-pressed={s.terminalOpen}
          onClick={() => set({ terminalOpen: !s.terminalOpen })}
        />
        <IconButton
          icon={detailsOpen ? ChevronRight : ChevronLeft}
          ref={toggleRef}
          title={detailsOpen ? "折叠对话详情" : "展开对话详情"}
          aria-expanded={detailsOpen}
          aria-controls="conversation-context"
          onClick={() => set({ contextOpen: !detailsOpen })}
        />
      </nav>
    </>
  );
}
