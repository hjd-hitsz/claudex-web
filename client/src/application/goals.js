import { isCompacting } from "../domain/compaction.js";

// 原生目标是事实来源；请求版本防止读取覆盖实时通知或后续操作。
export function createGoals({ get, set, rpc, navigation, onEvent }) {
  const revisions = new Map();
  const pending = new Map();
  function apply(id, goal) {
    set({
      goals: { ...get().goals, [id]: goal },
      goalErrors: { ...get().goalErrors, [id]: "" },
    });
  }
  onEvent(({ method, params: p = {} }) => {
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      revisions.set(p.threadId, (revisions.get(p.threadId) || 0) + 1);
      apply(p.threadId, p.goal ?? null);
    }
  });
  async function refreshGoal(id = get().current?.id) {
    if (!id || pending.has(id)) return;
    const revision = (revisions.get(id) || 0) + 1;
    revisions.set(id, revision);
    try {
      const { goal } = await rpc("thread/goal/get", { threadId: id });
      if (revisions.get(id) === revision) {
        apply(id, goal);
        set({ goalErrors: { ...get().goalErrors, [id]: "" } });
      }
    } catch (error) {
      if (revisions.get(id) === revision)
        set({ goalErrors: { ...get().goalErrors, [id]: error.message } });
    }
  }
  async function updateGoal(id, params, clear = false) {
    if (pending.has(id)) return false;
    const s = get();
    if (
      !s.connected ||
      s.loading ||
      isCompacting(s.compactions[id]) ||
      s.busy ||
      (s.threadAccess?.threadId === id && s.threadAccess.status !== "ready")
    )
      throw new Error("请等待连接和当前操作就绪后修改目标。");
    pending.set(id, true);
    set({ goalBusy: { ...get().goalBusy, [id]: true } });
    const revision = (revisions.get(id) || 0) + 1;
    revisions.set(id, revision);
    try {
      const result = await rpc(
        clear ? "thread/goal/clear" : "thread/goal/set",
        {
          threadId: id,
          origin: "user",
          ...params,
        },
      );
      if (revisions.get(id) === revision) apply(id, result.goal ?? null);
      set({ goalErrors: { ...get().goalErrors, [id]: "" } });
      return true;
    } finally {
      pending.delete(id);
      set({ goalBusy: { ...get().goalBusy, [id]: false } });
    }
  }
  let submitting = false;
  async function submitGoal(confirmed = false) {
    const s = get();
    if (
      submitting ||
      s.busy ||
      s.loading ||
      (!s.draft.trim() && !s.attachments.length)
    )
      return false;
    if (!confirmed && s.current && s.goals[s.current.id]) {
      set({
        modal: {
          type: "command",
          view: "goal-replace",
          thread: s.current,
          draft: s.draft,
        },
      });
      return false;
    }
    if (s.draft.trim().length > 4000)
      throw new Error("任务目标最多 4000 个字符。");
    submitting = true;
    try {
      const thread = await navigation.ensureThread();
      if (get().current?.id !== thread.id) return false;
      let objective = s.draft.trim();
      for (const attachment of s.attachments) {
        if (!attachment.path) {
          const result = await rpc("fs/uploadAttachment", {
            name: attachment.name,
            dataBase64: attachment.dataUrl.slice(
              attachment.dataUrl.indexOf(",") + 1,
            ),
          });
          attachment.path = result.path;
        }
        objective += `\n[${attachment.name}](${attachment.path})`;
      }
      if (objective.length > 4000)
        throw new Error("目标及附件引用最多 4000 个字符。");
      const saved = await updateGoal(thread.id, {
        objective,
        status: "active",
      });
      if (saved && get().current?.id === thread.id) {
        set({ goalMode: false });
        if (get().draft === s.draft) {
          set({
            draft: "",
            attachments: get().attachments.filter(
              (a) => !s.attachments.includes(a),
            ),
          });
          localStorage.removeItem("cx-draft-" + thread.id);
        }
      }
      return saved;
    } finally {
      submitting = false;
    }
  }
  return { refreshGoal, updateGoal, submitGoal };
}
