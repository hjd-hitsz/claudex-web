import React, { useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, LoaderCircle } from "lucide-react";
import { rpc, useStore } from "../../store.js";
import { useBackgroundPoll } from "./use-background-poll.js";

const statuses = {
  succeeded: "已完成",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  stopped: "已停止",
  interrupted: "已中断",
  timed_out: "已超时",
};

export function BackgroundTaskOutput({ task }) {
  const { connected } = useStore();
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [following, setFollowing] = useState(true);
  const [frozen, setFrozen] = useState("");
  const [retry, setRetry] = useState(false);
  const scroll = useRef(null);
  const status = result?.status || task.status;
  useBackgroundPoll(connected && (!error || retry), 1000, async (current) => {
    try {
      const next = await rpc("thread/backgroundTasks/read", {
        threadId: task.threadId,
        taskId: task.id,
      });
      if (!current()) return true;
      setResult(next);
      setError("");
      setRetry(false);
      return next.status !== "running";
    } catch (failure) {
      if (!current()) return true;
      setError(failure.message);
      setRetry(false);
      return true;
    }
  });
  const output = following ? result?.output : frozen;
  useLayoutEffect(() => {
    if (following && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [following, output]);

  return (
    <section className="background-task-output" aria-label="后台终端输出">
      <div className="background-task-output-status">
        <span role="status">
          {status === "running" && <LoaderCircle className="spin" size={13} />}
          {statuses[status] || "运行中"}
        </span>
        <div className="background-task-output-actions">
          {result?.exitCode != null && <span>退出码 {result.exitCode}</span>}
          {result?.logPath && (
            <a
              href={
                "/api/files?" + new URLSearchParams({ path: result.logPath })
              }
              download="background-terminal.log"
            >
              完整日志
            </a>
          )}
        </div>
      </div>
      <div className="background-task-output-body">
        <pre
          ref={scroll}
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            const bottom =
              element.scrollHeight - element.clientHeight - element.scrollTop <=
              8;
            if (following && !bottom) setFrozen(result?.output || "");
            setFollowing(bottom);
          }}
        >
          {output || (result ? "暂无输出" : "")}
        </pre>
        {!following && (
          <button
            type="button"
            className="icon-button background-task-follow"
            aria-label="回到最新输出"
            title="回到最新输出"
            onClick={() => setFollowing(true)}
          >
            <ArrowDown size={16} />
          </button>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => setRetry(true)}
          >
            重试
          </button>
        </div>
      )}
    </section>
  );
}
