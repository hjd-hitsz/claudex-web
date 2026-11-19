import React, { useEffect, useId, useRef, useState } from "react";
import { Square, TerminalSquare } from "lucide-react";
import { refreshBackgroundResults, rpc, set, useStore } from "../../store.js";
import { useBackgroundPoll } from "./use-background-poll.js";

export function BackgroundTaskMenu({ onOpenOutput }) {
  const s = useStore();
  const threadId = s.current?.id;
  const available =
    s.current?.backendId === "claude" ||
    s.backends.some(
      (backend) =>
        backend.id === "codex" && backend.backgroundTerminalAvailable,
    );
  const [tasks, setTasks] = useState([]);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(null);
  const [error, setError] = useState("");
  const button = useRef(null);
  const root = useRef(null);
  const id = useId();
  const seen = useRef(new Set());
  const watched = useRef(new Set());

  useBackgroundPoll(
    Boolean(available && threadId && s.connected),
    1500,
    async (current) => {
      try {
        const result = await rpc("thread/backgroundTasks/list", { threadId });
        if (!current()) return true;
        setTasks(result.tasks);
        setError("");
        for (const task of result.tasks) watched.current.add(task.id);
        const completed = (result.completed || [])
          .filter(
            (task) =>
              !seen.current.has(task.id) &&
              (watched.current.has(task.id) ||
                Date.now() - task.completedAt < 300000),
          )
          .map((task) => task.id);
        if (completed.length) {
          const found = await refreshBackgroundResults(threadId, completed);
          if (current())
            for (const id of found) {
              seen.current.add(id);
              watched.current.delete(id);
            }
        }
      } catch (failure) {
        if (current()) setError(failure.message);
      }
    },
  );
  useEffect(() => {
    if (!tasks.length) setOpen(false);
  }, [tasks.length]);
  useEffect(() => {
    if (!open) return;
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  if (!tasks.length) return null;

  async function stop(task) {
    setStopping(task.id);
    setError("");
    try {
      await rpc("thread/backgroundTasks/cancel", { threadId, taskId: task.id });
      setTasks((list) => list.filter((entry) => entry.id !== task.id));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setStopping(null);
    }
  }
  return (
    <div className="background-task-trigger" ref={root}>
      <button
        type="button"
        className={
          "icon-button background-task-count" + (open ? " active" : "")
        }
        ref={button}
        aria-label={`后台终端，${tasks.length} 个运行中`}
        title="后台终端"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <TerminalSquare size={16} />
        <span>{tasks.length}</span>
      </button>
      {open && (
        <section
          id={id}
          className="background-task-popover"
          aria-label="后台终端"
        >
          <header>
            <strong>后台终端</strong>
            <small>{tasks.length} 个运行中</small>
          </header>
          <ul>
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="background-task-select"
                  onClick={() => {
                    set({
                      panel: "background-task",
                      panelBackgroundTask: { ...task, threadId },
                    });
                    setOpen(false);
                    onOpenOutput();
                  }}
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
      )}
    </div>
  );
}
