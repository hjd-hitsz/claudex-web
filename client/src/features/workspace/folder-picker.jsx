import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  ArrowRight,
  ChevronRight,
  Folder,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import { get, rpc } from "../../store.js";
import { IconButton } from "../../ui/primitives.jsx";

export function FolderPicker({ onChoose, initial = get().cwd }) {
  const startPath = useRef(initial).current;
  const request = useRef(0);
  const editButton = useRef(null);
  const pathInput = useRef(null);
  const breadcrumbBar = useRef(null);
  const [directory, setDirectory] = useState(null);
  const [input, setInput] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const path = directory?.path ?? startPath;
  const editing = input !== null;

  const load = useCallback(async (target, fromInput = false) => {
    const id = ++request.current;
    setLoading(true);
    setErr("");
    try {
      const { entries } = await rpc("fs/readDirectory", { path: target });
      if (id !== request.current) return;
      setDirectory({
        path: target,
        entries: entries
          .filter((e) => e.isDirectory)
          .sort((a, b) => a.fileName.localeCompare(b.fileName)),
      });
      setInput(null);
      if (fromInput) editButton.current?.focus();
    } catch (e) {
      if (id === request.current) setErr(e.message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(startPath);
    return () => {
      request.current += 1;
    };
  }, [load, startPath]);

  useEffect(() => {
    if (editing) {
      pathInput.current?.focus();
      pathInput.current?.select();
    } else if (breadcrumbBar.current) {
      breadcrumbBar.current.scrollTop = breadcrumbBar.current.scrollHeight;
    }
  }, [editing, path]);

  function cancelEdit() {
    request.current += 1;
    setLoading(false);
    setErr("");
    setInput(null);
    editButton.current?.focus();
  }

  const crumbs = [
    { name: "/", target: "/" },
    ...Array.from((path || "").matchAll(/[^/]+/g), (segment) => ({
      name: segment[0],
      target: path.slice(0, segment.index + segment[0].length),
    })),
  ];

  return (
    <>
      <div className="directory-address">
        {editing ? (
          <input
            ref={pathInput}
            aria-label="目录路径"
            value={input}
            readOnly={loading}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
              if (e.key === "Enter" && input && !loading) load(input, true);
            }}
          />
        ) : (
          <nav
            ref={breadcrumbBar}
            className="directory-breadcrumbs"
            aria-label="目录层级"
          >
            <ol>
              {crumbs.map(({ name, target }, index) => {
                const current = index === crumbs.length - 1;
                return (
                  <li key={target}>
                    {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
                    <button
                      type="button"
                      title={current ? path || target : target}
                      aria-current={current ? "location" : undefined}
                      onClick={() => load(current && path ? path : target)}
                    >
                      <span className="ellipsis">{name}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <div className="directory-address-actions">
          <IconButton
            ref={editButton}
            icon={editing ? X : Pencil}
            title={editing ? "取消编辑路径" : "编辑目录路径"}
            onClick={() => (editing ? cancelEdit() : setInput(path || ""))}
            disabled={loading && !editing}
          />
          <IconButton
            icon={editing ? ArrowRight : RefreshCw}
            title={editing ? "打开目录" : "刷新目录"}
            onClick={() => (editing ? load(input, true) : load(path || "/"))}
            disabled={loading || (editing && !input)}
          />
        </div>
      </div>
      <label className="directory-options">
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => setShowHidden(e.target.checked)}
        />
        显示隐藏文件夹
      </label>
      {err && (
        <div className="inline-error" role="alert">
          {err}
        </div>
      )}
      <div className="directory-list" aria-busy={loading}>
        {loading ? (
          <div className="loading">读取目录…</div>
        ) : (
          directory?.entries
            .filter((e) => showHidden || !e.fileName.startsWith("."))
            .map((e) => (
              <button
                key={e.fileName}
                onClick={() =>
                  load(path.replace(/\/+$/, "") + "/" + e.fileName)
                }
              >
                <Folder size={17} />
                <span>{e.fileName}</span>
                <ChevronRight size={14} />
              </button>
            ))
        )}
      </div>
      <div className="modal-actions">
        <button
          className="primary"
          disabled={!directory || loading}
          onClick={() => onChoose(path)}
        >
          选择此目录
        </button>
      </div>
    </>
  );
}
