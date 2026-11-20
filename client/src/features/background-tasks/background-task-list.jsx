import React from "react";
import { Square, TerminalSquare } from "lucide-react";

export function BackgroundTaskList({ tasks, stopping, error, stop, onSelect }) {
  if (!tasks.length) return null;
  return (
    <section className="context-background-tasks" aria-label="后台终端">
      <div className="context-section-heading">
        <strong>后台终端</strong>
        <small>{tasks.length} 个运行中</small>
      </div>
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              className="background-task-select"
              title={task.title}
              onClick={() => onSelect(task)}
            >
              <TerminalSquare size={15} />
              <span>
                <strong>{task.title}</strong>
                {task.startedAt && (
                  <small>
                    已运行{" "}
                    {Math.max(
                      0,
                      Math.floor((Date.now() - task.startedAt) / 1000),
                    )}{" "}
                    秒
                  </small>
                )}
              </span>
            </button>
            <button
              type="button"
              className="icon-button"
              title="停止"
              aria-label={`停止 ${task.title}`}
              disabled={Boolean(stopping)}
              onClick={() => stop(task)}
            >
              <Square size={13} />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </section>
  );
}
