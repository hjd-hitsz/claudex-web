import { requestServiceMaintenance } from "../infrastructure/service-maintenance.js";

export function createServiceMaintenance({
  request = requestServiceMaintenance,
} = {}) {
  let state = {
    status: null,
    pending: false,
    pendingAction: null,
    error: "",
    loadError: "",
    notice: null,
    refreshNeeded: false,
  };
  const listeners = new Set();
  let inFlight, errorTimer;
  let feedbackRevision = 0;
  let feedbackTask = null;
  function publish(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function clearErrorLater() {
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => publish({ error: "", notice: null }), 5000);
  }
  function dismissFeedback() {
    feedbackRevision++;
    feedbackTask = null;
    clearTimeout(errorTimer);
    publish({ error: "", loadError: "", notice: null, refreshNeeded: false });
  }
  const controller = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismissFeedback,
    async request(action) {
      if (inFlight) return inFlight;
      if (action) dismissFeedback();
      const revision = feedbackRevision;
      publish({ pending: true, pendingAction: action || null });
      inFlight = request(action)
        .then((status) => {
          const task = status.task;
          const patch = { status, loadError: "" };
          if (revision === feedbackRevision) {
            if (["update", "restart"].includes(action))
              feedbackTask = task?.startedAt || null;
            if (
              feedbackTask &&
              task?.startedAt === feedbackTask &&
              ["completed", "failed"].includes(task.state)
            ) {
              feedbackTask = null;
              patch.notice = {
                state: task.state,
                message:
                  task.state === "completed"
                    ? "服务已重启，请刷新网页。"
                    : task.error || "服务操作失败，请重试",
              };
              patch.refreshNeeded = task.state === "completed";
              if (task.state === "failed") clearErrorLater();
            }
          }
          publish(patch);
        })
        .catch((error) => {
          if (revision !== feedbackRevision) return;
          if (!action) publish({ loadError: error.message });
          else if (revision === feedbackRevision) {
            publish({ error: error.message });
            clearErrorLater();
          }
        })
        .finally(() => {
          inFlight = null;
          publish({ pending: false, pendingAction: null });
        });
      return inFlight;
    },
    start() {
      let disposed = false,
        timer;
      const poll = async () => {
        await controller.request();
        if (!disposed)
          timer = setTimeout(
            poll,
            ["updating", "restarting"].includes(state.status?.task?.state)
              ? 2000
              : 60000,
          );
      };
      void poll();
      return () => {
        disposed = true;
        clearTimeout(timer);
      };
    },
  };
  return controller;
}

export const serviceMaintenance = createServiceMaintenance();
