import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  Folder,
  ChevronRight,
  ArrowUp,
  RefreshCw,
  X,
  Save,
  Paperclip,
  Copy,
  Search,
  Eye,
  Code,
  FileDiff,
  ArrowUpRight,
  Download,
} from "lucide-react";
import { createWorkspaceBuffers } from "../../application/workspace-buffers.js";
import { workspaceDownloadProps } from "../../infrastructure/workspace-files.js";
import { CodeEditor } from "./code-editor.jsx";
import { isMarkdownFile } from "./editor-language.js";
import { fileChangeHighlights } from "../../domain/file-changes.js";
import { FileMarkdownEditor } from "./file-markdown-editor.jsx";
import { FilePreview } from "./file-preview.jsx";
import {
  useStore,
  get,
  set,
  rpc,
  report,
  notice,
  basename,
  addAttachment,
  uid,
  copy,
} from "../../store.js";
import { IconButton } from "../../ui/primitives.jsx";
import { DiffBlock } from "../../ui/diff-block.jsx";
import { TreeRow } from "./file-tree.jsx";
export function FilePanel() {
  const s = useStore();
  const [workspace] = useState(() =>
    createWorkspaceBuffers({
      get,
      rpc,
      report,
      notice,
      confirmDiscard: (message) => window.confirm(message),
    }),
  );
  const { views, directory, dirty } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const { path, entries, loading } = directory;
  const owner = s.current?.id ?? null;
  const { buffer, change } = views.get(owner) ?? {};
  const {
    path: file,
    change: fileChange,
    preview,
    text,
    original,
    kind: fileKind,
    token,
  } = buffer ?? {};
  const fileVisible = Boolean(buffer);
  const changeVisible = Boolean(change);
  const markdownFile = file && isMarkdownFile(file);
  const [filter, setFilter] = useState("");
  const changesMatch = useMemo(
    () =>
      !fileChange ||
      fileChangeHighlights(original, fileChange.diff, fileChange.patches)
        .matches,
    [original, fileChange],
  );
  const edit = (value) => workspace.updateBuffer(owner, token, { text: value });
  const { loadDirectory, openFile, showDiff, save } = workspace;
  useEffect(() => {
    setFilter("");
    workspace.syncDirectory();
  }, [workspace, owner, s.cwd, s.connected, s.backendId, s.providerId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const intent = s.panelFile;
    if (!intent) return;
    void workspace.navigate(intent).then((changedDirectory) => {
      if (changedDirectory) setFilter("");
    });
    set({ panelFile: null });
  }, [s.panelFile, workspace]);
  useEffect(() => workspace.dispose, [workspace]);
  useEffect(() => {
    const key = (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "s" &&
        fileVisible
      ) {
        event.preventDefault();
        if (!changeVisible && !fileKind) void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [changeVisible, fileVisible, fileKind, save]);
  return (
    <>
      <div className="panel-heading">
        <span>
          <Folder size={15} /> 文件
        </span>
        <div>
          <IconButton
            icon={RefreshCw}
            title="刷新文件"
            onClick={() => loadDirectory(path)}
          />
          <IconButton
            icon={X}
            title="关闭文件面板"
            onClick={() => set({ panel: null })}
          />
        </div>
      </div>
      {changeVisible ? (
        <>
          <div className="file-tab">
            <button onClick={() => showDiff(null)}>
              <ChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
              {fileVisible ? "返回文件" : "文件列表"}
            </button>
            <span title={change.path}>{basename(change.path)} · 变更</span>
            <IconButton
              icon={ArrowUpRight}
              title="查看完整文件变更"
              onClick={() => openFile(change.path, change)}
            />
            <IconButton
              icon={Code}
              title="打开源文件"
              onClick={() => openFile(change.path)}
            />
            <IconButton
              icon={Copy}
              title="复制文件差异"
              onClick={() => copy(change.diff)}
            />
          </div>
          <div className="file-diff-view" role="region" aria-label="文件变更">
            <div className="file-diff-path">
              {change.oldPath && change.oldPath !== change.path && (
                <>{change.oldPath} → </>
              )}
              {change.path}
            </div>
            <DiffBlock diff={change.diff} />
          </div>
          <div className="file-status">
            {change.path}
            <span>本轮变更</span>
          </div>
        </>
      ) : fileVisible ? (
        <>
          <div className="file-tab">
            <button onClick={workspace.leaveFile}>
              <ChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
              文件列表
            </button>
            <span title={file}>
              {basename(file)}
              {text !== original ? " •" : ""}
            </span>
            <a
              className="file-download"
              {...workspaceDownloadProps(file, basename(file))}
              title="下载文件"
              aria-label="下载文件"
            >
              <Download size={17} aria-hidden="true" />
            </a>
            {fileChange && (
              <>
                <IconButton
                  icon={FileDiff}
                  title="查看本轮差异片段"
                  onClick={() => showDiff(fileChange)}
                />
                <IconButton
                  icon={Code}
                  title="打开源文件"
                  onClick={() => openFile(file)}
                />
              </>
            )}
            {markdownFile && !fileKind && (
              <IconButton
                icon={preview ? Code : Eye}
                title={preview ? "编辑 Markdown 源码" : "预览 Markdown"}
                aria-pressed={preview}
                onClick={() =>
                  workspace.updateBuffer(owner, token, { preview: !preview })
                }
              />
            )}
            <IconButton
              icon={Paperclip}
              title="将文件加入消息"
              onClick={() => {
                addAttachment({
                  id: uid(),
                  name: basename(file),
                  input: {
                    type: "text",
                    text: "请参考本机文件：" + file,
                    text_elements: [],
                  },
                });
                notice("已加入消息附件");
              }}
            />
            {!fileKind && (
              <IconButton
                icon={Save}
                title="保存文件"
                disabled={text === original}
                onClick={save}
              />
            )}
          </div>
          {fileKind ? (
            s.panel === "files" && (
              <FilePreview key={file} path={file} kind={fileKind} />
            )
          ) : markdownFile && preview ? (
            <FileMarkdownEditor
              key={JSON.stringify([owner, file])}
              path={file}
              text={text}
              onChange={edit}
            />
          ) : (
            <CodeEditor
              key={JSON.stringify([owner, file])}
              path={file}
              text={text}
              onChange={edit}
              diff={fileChange?.diff || ""}
              patches={fileChange?.patches}
            />
          )}
          <div className="file-status">
            {file}
            {fileChange && (
              <span
                title={
                  changesMatch
                    ? "绿色为新增内容，红色为只读的删除内容"
                    : "可通过顶部的差异按钮查看本轮记录"
                }
              >
                {changesMatch ? "本轮变更" : "当前内容与本轮记录不同"}
              </span>
            )}
            {text !== original && <b>未保存</b>}
          </div>
        </>
      ) : (
        <>
          <div className="file-location">
            <IconButton
              icon={ArrowUp}
              title="上一级目录"
              onClick={() =>
                loadDirectory(path.slice(0, path.lastIndexOf("/")) || "/")
              }
            />
            <span title={path}>{path}</span>
          </div>
          <label className="panel-search">
            <Search size={14} />
            <input
              placeholder="筛选当前目录"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <div className="file-tree">
            {loading ? (
              <div className="loading">读取文件…</div>
            ) : (
              entries
                .filter((e) =>
                  e.fileName.toLowerCase().includes(filter.toLowerCase()),
                )
                .map((e) => (
                  <TreeRow
                    key={path + "/" + e.fileName}
                    entry={e}
                    path={path}
                    onOpen={openFile}
                  />
                ))
            )}
          </div>
        </>
      )}
    </>
  );
}
