import React, { useState } from "react";
import { X, Pencil } from "lucide-react";
import { useStore, set } from "../../store.js";
import { IconButton } from "../../ui/primitives.jsx";

export function ExecutionError() {
  const s = useStore();
  const threadId = s.current?.id;
  const turn = s.active[threadId] ? null : s.turns[threadId]?.[0];
  const [dismissed, dismiss] = useState({});
  const failureId =
    turn?.status === "failed" && s.compactions[threadId]?.turnId !== turn.id
      ? `${threadId}:${turn.id}`
      : "";
  const showTurnFailure =
    !s.error && failureId && failureId !== dismissed[threadId];
  const message = showTurnFailure
    ? turn.error?.message || "任务失败，请重试。"
    : s.error;
  const user = showTurnFailure
    ? s.items.find(
        (item) => item.turnId === turn.id && item.type === "userMessage",
      )
    : null;
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {user && (
        <button
          type="button"
          className="secondary"
          disabled={s.busy || s.loading || !s.connected}
          onClick={() =>
            set({
              messageEditRequest: {
                threadId,
                itemId: user.id,
                revision: Date.now(),
              },
            })
          }
        >
          <Pencil size={14} />
          编辑并重试
        </button>
      )}
      <IconButton
        icon={X}
        title="关闭错误提示"
        onClick={() => {
          if (showTurnFailure)
            dismiss((previous) => ({ ...previous, [threadId]: failureId }));
          else set({ error: "" });
        }}
      />
    </div>
  );
}
