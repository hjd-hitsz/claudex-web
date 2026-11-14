import { backendReady } from "../../domain/backends.js";
import React, { useEffect } from "react";
import { Target, Pause, Play, Pencil, X } from "lucide-react";
import * as store from "../../store.js";
import { IconButton } from "../../ui/primitives.jsx";
import { isCompacting } from "../../domain/compaction.js";
export const goalStates = {
  active: "正在追踪目标",
  paused: "目标已暂停",
  blocked: "目标遇到阻塞",
  usageLimited: "目标用量受限",
  budgetLimited: "目标预算已达上限",
  complete: "目标已完成",
};
export function GoalSummary() {
  const s = store.useStore(),
    id = s.current?.id;
  const ready = backendReady(s);
  useEffect(() => {
    if (s.connected && ready && id) store.refreshGoal(id);
  }, [id, s.connected, ready]);
  const goal = s.goals[id],
    error = s.goalErrors[id];
  if (!goal && !error) return null;
  const disabled =
    !s.connected || s.busy || s.goalBusy[id] || isCompacting(s.compactions[id]);
  return (
    <div className="goal-summary">
      {goal && (
        <>
          <Target size={16} />
          <button
            className="goal-summary-text"
            onClick={() => store.set({ panel: "goal" })}
          >
            <strong>{goalStates[goal.status] || goal.status}</strong>
            <span>{goal.objective}</span>
          </button>
          {goal.status !== "complete" && (
            <IconButton
              icon={goal.status === "active" ? Pause : Play}
              title={goal.status === "active" ? "暂停目标" : "恢复目标"}
              disabled={disabled}
              onClick={() =>
                store
                  .updateGoal(id, {
                    status: goal.status === "active" ? "paused" : "active",
                  })
                  .catch(store.report)
              }
            />
          )}
          <IconButton
            icon={Pencil}
            title="编辑目标"
            onClick={() => store.set({ panel: "goal" })}
          />
          <IconButton
            icon={X}
            title="清除目标"
            disabled={disabled}
            onClick={() => store.updateGoal(id, {}, true).catch(store.report)}
          />
        </>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <button onClick={() => store.refreshGoal(id)}>重试</button>
        </div>
      )}
    </div>
  );
}
