import React from "react";
import { backgroundCompletionResults } from "../../domain/background-results.js";
import { set } from "../../store.js";

const jobStatuses = {
  succeeded: "已完成",
  failed: "执行失败",
  timed_out: "已超时",
  cancelled: "已停止",
  interrupted: "已中断",
};

export function BackgroundCompletionReceipt({ items, status, threadId }) {
  const results = items.flatMap(backgroundCompletionResults);
  if (!results.length) return null;
  return (
    <section
      className="background-completion-receipt"
      aria-label="后台任务结果"
    >
      {status === "completed" && <p>模型本轮未生成回复正文。</p>}
      <ul>
        {results.map(
          ({ job_id: id, title, status: jobStatus, exit_code: exitCode }) => (
            <li key={id}>
              <span>{title}</span>
              <small>
                {jobStatuses[jobStatus] || jobStatus}
                {exitCode != null && ` · 退出码 ${exitCode}`}
              </small>
              {threadId && (
                <button
                  type="button"
                  onClick={() =>
                    set({
                      panel: "background-task",
                      panelBackgroundTask: {
                        id,
                        threadId,
                        title,
                        status: jobStatus,
                      },
                    })
                  }
                >
                  查看输出
                </button>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
