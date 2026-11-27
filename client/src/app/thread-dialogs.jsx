import { ThreadListErrors } from "./thread-list-errors.jsx";
import {
  mergeThreadTimes,
  preserveFailedBackendThreads,
  sortThreads,
} from "../domain/thread-order.js";
import { visibleBackendThreads } from "../domain/backend-visibility.js";
import { RpcConnectionError } from "../infrastructure/rpc-client.js";
import { resourceTarget } from "../../../shared/backend-identity.mjs";
import React, { useState, useEffect, useRef } from "react";

import {
  Search,
  ChevronRight,
  MessageSquare,
  LoaderCircle,
} from "lucide-react";
import {
  useStore,
  set,
  openThread,
  listThreads,
  rename,
  deleteThread,
  titleOf,
  report,
} from "../store.js";
import { Empty } from "../ui/primitives.jsx";
export function SearchDialog() {
  const s = useStore();
  const [q, query] = useState(""),
    [results, update] = useState(s.threads),
    [loading, load] = useState(false),
    [errors, setErrors] = useState([]),
    [attempt, retry] = useState(0);
  const epoch = useRef(0);
  const previousScope = useRef({ archived: s.archived });
  const enabledKey = (s.backends || [])
    .filter((b) => b.enabled)
    .map((b) => b.id)
    .join(",");
  const known = new Map(s.threads.map((thread) => [thread.id, thread]));
  const visibleResults = sortThreads(
    visibleBackendThreads(results, s.backends).map((thread) =>
      mergeThreadTimes(thread, known.get(thread.id)),
    ),
    s.active,
  ).slice(0, 60);
  useEffect(() => {
    if (!s.connected) {
      load(false);
      return;
    }
    const n = ++epoch.current;
    const params = { archived: s.archived, searchTerm: q || undefined };
    let failures = [];
    const timer = setTimeout(() => {
      load(true);
      listThreads(params, {
        onBackendErrors: (value) => {
          failures = value;
        },
      })
        .then((records) => {
          if (n !== epoch.current) return;
          setErrors(failures);
          const previousParams = previousScope.current;
          previousScope.current = params;
          update((previous) =>
            preserveFailedBackendThreads(
              records,
              previous,
              failures,
              params,
              previousParams,
            ),
          );
        })
        .catch((error) => {
          if (n !== epoch.current || error instanceof RpcConnectionError)
            return;
          setErrors([{ message: error.message }]);
          update((previous) =>
            preserveFailedBackendThreads(
              [],
              previous,
              [{ backendId: "codex" }, { backendId: "claude" }],
              params,
              previousScope.current,
            ),
          );
        })
        .finally(() => {
          if (n === epoch.current) load(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      epoch.current++;
    };
  }, [q, s.archived, s.connected, attempt, enabledKey]);
  return (
    <>
      <label className="search-input">
        <Search size={20} />
        <input
          data-dialog-focus
          placeholder="按标题或内容搜索对话"
          value={q}
          onChange={(e) => query(e.target.value)}
        />
        {loading && <LoaderCircle size={16} className="spin" />}
      </label>
      <ThreadListErrors
        backends={s.backends}
        errors={errors}
        loading={loading || !s.connected}
        onRetry={() => retry((value) => value + 1)}
      />
      <div className="search-results">
        {visibleResults.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              set({ modal: null });
              openThread(t.id);
            }}
          >
            <MessageSquare size={17} />
            <span>
              <b>{titleOf(t)}</b>
              <small>{t.cwd}</small>
            </span>
            <ChevronRight size={14} />
          </button>
        ))}
        {s.connected &&
          !visibleResults.length &&
          !loading &&
          !errors.length && <Empty icon={Search} title="没有找到对话" />}
      </div>
    </>
  );
}
export function RenameDialog({ thread }) {
  const [name, update] = useState(titleOf(thread));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        rename(thread, name)
          .then(() => set({ modal: null }))
          .catch(report);
      }}
    >
      <label className="field-label">
        对话名称
        <input
          data-dialog-focus
          value={name}
          onChange={(e) => update(e.target.value)}
        />
      </label>
      <div className="modal-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => set({ modal: null })}
        >
          取消
        </button>
        <button className="primary" disabled={!name.trim()}>
          保存
        </button>
      </div>
    </form>
  );
}
export function DeleteDialog({ thread }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await deleteThread(thread);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <div className="delete-dialog">
      <p>
        删除“<strong>{titleOf(thread)}</strong>”？
      </p>
      <p className="section-description">
        {resourceTarget(thread.id).backendId === "agy"
          ? "当前 Antigravity 原生会话也将永久删除。项目文件会保留。"
          : "删除后无法从网页恢复此对话。项目文件会保留。"}
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => set({ modal: null })}
        >
          取消
        </button>
        <button className="danger-button" disabled={busy} onClick={remove}>
          {busy ? "正在删除…" : "删除对话"}
        </button>
      </div>
    </div>
  );
}
