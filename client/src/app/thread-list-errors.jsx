import React from "react";

export function ThreadListErrors({
  backends = [],
  errors = [],
  onRetry,
  loading = false,
}) {
  if (!errors.length) return null;
  return (
    <div className="inline-error" role="alert">
      {errors.map((error, index) => (
        <p key={error.backendId || index}>
          {backends.find((backend) => backend.id === error.backendId)?.name ||
            "对话"}
          读取失败：{error.message}
        </p>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={loading}
        onClick={onRetry}
      >
        重试
      </button>
    </div>
  );
}
