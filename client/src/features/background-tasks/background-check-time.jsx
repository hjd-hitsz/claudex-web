import React from "react";

const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const date = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});

export function BackgroundCheckTime({ task, className }) {
  if (task?.status !== "running" || !Number.isFinite(task.nextCheckAt))
    return null;
  const next = new Date(task.nextCheckAt);
  const now = new Date();
  const time = clock.format(next);
  const shown =
    next.toDateString() === now.toDateString()
      ? time
      : `${date.format(next)} ${time}`;
  const label =
    task.checkDelivery === "uncertain"
      ? "正在确认检查通知"
      : next <= now
        ? "检查时间已到"
        : "下次检查 " + shown;
  return (
    <time
      className={className}
      dateTime={next.toISOString()}
      title={next.toLocaleString("zh-CN")}
    >
      {label}
    </time>
  );
}
