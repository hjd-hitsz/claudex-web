import React, { useContext } from "react";
import {
  deliveryCardPreviewLimit,
  deliverySnippet,
} from "../../../../shared/delivery-summary.mjs";
import {
  backgroundNoticeResults,
  isBackgroundCheck,
} from "../../domain/background-results.js";
import { formatElapsed } from "../../domain/turn-timing.js";
import { BackgroundTasks } from "../background-tasks/background-task-provider.jsx";
import { DeliverySummary } from "./delivery-summary.jsx";
import { set } from "../../store.js";

const jobStatuses = {
  running: "检查时仍在运行",
  succeeded: "已完成",
  failed: "执行失败",
  timed_out: "已超时",
  cancelled: "已停止",
  interrupted: "已中断",
};

export function BackgroundTaskReceipt({ items, threadId }) {
  const { completed = [] } = useContext(BackgroundTasks);
  const cards = items.flatMap((item) =>
    backgroundNoticeResults(item).map((result) => {
      const { job_id: id, title, status, exit_code: exitCode } = result;
      const job = threadId && completed.find((task) => task.id === id);
      const elapsed = isBackgroundCheck(item)
        ? result.running_for_ms
        : (result.duration_ms ?? (job && job.completedAt - job.startedAt));
      const meta = [jobStatuses[status] || status];
      if (Number.isFinite(elapsed))
        meta.push(formatElapsed(Math.max(0, elapsed)));
      if (exitCode != null) meta.push(`退出码 ${exitCode}`);
      return (
        <DeliverySummary
          key={`${item.id}:${id}`}
          source="background"
          title={title || "后台终端"}
          status={meta.filter(Boolean)}
          preview={deliverySnippet(
            result.output_tail,
            deliveryCardPreviewLimit,
          )}
          action="查看输出"
          onOpen={
            threadId &&
            (() =>
              set({
                contextOpen: true,
                panel: "background-task",
                panelBackgroundTask: { id, threadId, title, status },
              }))
          }
        />
      );
    }),
  );
  return cards.length ? (
    <div className="background-completion-receipt">{cards}</div>
  ) : null;
}
