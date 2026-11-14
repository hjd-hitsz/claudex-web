import React, { useEffect, useRef, useState } from "react";
import { RefreshCw, LoaderCircle } from "lucide-react";
import * as store from "../../store.js";
import { commandPages } from "./composer-commands.js";

export const commandTitles = {
  "goal-replace": "替换当前目标？",
  stop: "清理后台终端",
};

function useResource(load, key) {
  const { connected } = store.useStore();
  const [attempt, retry] = useState(0);
  const [state, update] = useState({ loading: true });
  useEffect(() => {
    let cancelled = false;
    update({ loading: true });
    Promise.resolve()
      .then(() => load(() => !cancelled))
      .then(
        (data) => {
          if (!cancelled) update({ data, loading: false });
        },
        (error) => {
          if (!cancelled) update({ error: error.message, loading: false });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [key, attempt, connected]);
  return { ...state, reload: () => retry((n) => n + 1) };
}

function ResourceState({ resource }) {
  if (resource.loading)
    return (
      <p className="loading">
        <LoaderCircle size={16} className="spin" />
        正在读取…
      </p>
    );
  if (resource.error)
    return (
      <div className="inline-error" role="alert">
        {resource.error}
        <button className="secondary" onClick={resource.reload}>
          重试
        </button>
      </div>
    );
  return null;
}

function useAction() {
  const [state, update] = useState({ busy: false, error: "" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return {
    ...state,
    run: async (fn) => {
      if (state.busy) return;
      update({ busy: true, error: "" });
      try {
        await fn();
        if (live.current) update({ busy: false, error: "" });
      } catch (error) {
        if (live.current) update({ busy: false, error: error.message });
      }
    },
  };
}

function ActionError({ action }) {
  return (
    action.error && (
      <p className="inline-error" role="alert">
        {action.error}
      </p>
    )
  );
}

function GoalConfirmation({ modal }) {
  const action = useAction();
  return (
    <>
      <p>保留当前对话，并用输入框中的内容替换已保存的目标。</p>
      <p className="goal-confirm-objective">{modal.draft}</p>
      <ActionError action={action} />
      <div className="modal-actions">
        <button
          className="secondary"
          disabled={action.busy}
          onClick={() => store.set({ modal: null })}
        >
          取消
        </button>
        <button
          className="primary"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              if (
                store.get().current?.id !== modal.thread.id ||
                store.get().draft !== modal.draft
              )
                throw new Error("对话或目标内容已变化，请关闭窗口后重新提交。");
              if (await store.submitGoal(true)) store.set({ modal: null });
            })
          }
        >
          {action.busy ? "正在保存…" : "替换目标"}
        </button>
      </div>
    </>
  );
}

function TerminalsDialog({ modal }) {
  const resource = useResource(
    (current) =>
      commandPages(
        "thread/backgroundTerminals/list",
        { threadId: modal.thread.id, limit: 100 },
        current,
      ),
    modal.thread.id,
  );
  const action = useAction();
  return (
    <>
      <ResourceState resource={resource} />
      {resource.data && (
        <>
          {!resource.data.length && <p>当前对话没有后台终端。</p>}
          {resource.data.map((terminal) => (
            <div className="command-record" key={terminal.processId}>
              <strong>{terminal.command}</strong>
              <small>
                {terminal.cwd}
                {terminal.osPid != null && ` · PID ${terminal.osPid}`}
              </small>
            </div>
          ))}
          <ActionError action={action} />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={action.busy}
              onClick={resource.reload}
            >
              <RefreshCw size={14} />
              刷新
            </button>
            <button
              className="danger-button"
              disabled={action.busy || !resource.data.length}
              onClick={() =>
                action.run(async () => {
                  await store.rpc("thread/backgroundTerminals/clean", {
                    threadId: modal.thread.id,
                  });
                  resource.reload();
                })
              }
            >
              停止全部后台终端
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function CommandDialog({ modal }) {
  switch (modal.view) {
    case "goal-replace":
      return <GoalConfirmation modal={modal} />;
    case "stop":
      return <TerminalsDialog modal={modal} />;
  }
}
