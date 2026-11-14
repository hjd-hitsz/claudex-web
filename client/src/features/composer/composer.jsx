import { GoalSummary } from "./goal-summary.jsx";
import { ModelSelect } from "./model-select.jsx";
import { InputQueue } from "./input-queue.jsx";
import { backendReady, backendCapability } from "../../domain/backends.js";
import React, { useEffect, useRef, useState } from "react";

import {
  ArrowUp,
  Square,
  Plus,
  X,
  ChevronDown,
  LoaderCircle,
  Paperclip,
  Folder,
  ListChecks,
  AlertCircle,
  RefreshCw,
  Maximize2,
  Minimize2,
} from "lucide-react";
import {
  useStore,
  useDraft,
  set,
  setDraft,
  refreshThreadAccess,
  stop,
  report,
  attachFile,
  basename,
} from "../../store.js";
import { IconButton } from "../../ui/primitives.jsx";
import { useComposerShortcuts } from "../commands/shortcuts.jsx";
import { submitComposer } from "../commands/composer-commands.js";
import { ServiceTierToggle } from "./service-tier-toggle.jsx";
import { ReasoningEffortControl } from "./reasoning-effort.jsx";
import { ComposerAnnotations } from "../annotations/message-annotations.jsx";
import { useAnnotationDrafts } from "../annotations/annotation-drafts.js";
import { isCompacting } from "../../domain/compaction.js";
import { CompactionStatus } from "./compaction-status.jsx";
import { MarkdownEditor } from "./markdown-editor.jsx";
import { AttachmentPreview } from "./attachment-preview.jsx";
import { ComposerSurface } from "./composer-surface.jsx";
export function Composer() {
  const [preview, setPreview] = useState(null);
  const [enlarged, setEnlarged] = useState(false);
  const s = useStore(),
    draft = useDraft(),
    area = useRef(),
    files = useRef();
  useEffect(() => setEnlarged(false), [s.current?.id, s.backendId, s.modal]);
  const annotationDrafts = useAnnotationDrafts(s.current?.id);
  const shortcuts = useComposerShortcuts(area);
  const active = s.active[s.current?.id];
  const compaction = s.compactions[s.current?.id];
  const compacting = isCompacting(compaction);
  function submit() {
    shortcuts.close();
    return submitComposer();
  }
  function add(files) {
    return Promise.all(
      Array.from(files, (file) => attachFile(file).catch(report)),
    );
  }
  const token = s.tokenUsage[s.current?.id];
  const usage = token?.last?.totalTokens;
  const windowSize = token?.modelContextWindow;
  const access = s.threadAccess;
  const checking = s.loading || access?.status === "checking";
  const unavailable =
    s.loading ||
    (access && access.status !== "ready" && !(checking && access.background));
  return (
    <ComposerSurface
      expanded={enlarged}
      onClose={() => {
        setEnlarged(false);
        requestAnimationFrame(() => area.current?.focus());
      }}
    >
      <InputQueue />
      <GoalSummary />
      {compaction && (
        <CompactionStatus
          key={s.current?.id + compaction.id}
          entry={compaction}
        />
      )}
      {!unavailable && shortcuts.popup}
      {unavailable ? (
        <div
          className="composer-access"
          role="status"
          aria-live="polite"
          aria-busy={checking}
        >
          {checking ? (
            <LoaderCircle size={20} className="spin" />
          ) : (
            <AlertCircle size={20} />
          )}
          <div className="composer-access-content">
            <strong>
              {checking
                ? "正在检查对话状态…"
                : access?.status === "blocked"
                  ? "此对话由另一端使用"
                  : "暂时无法连接此对话"}
            </strong>
            {!checking && access?.status !== "blocked" && access?.message && (
              <p>{access.message}</p>
            )}
          </div>
          <button
            className="secondary"
            aria-label="重试连接对话"
            disabled={!s.connected || checking}
            onClick={() => refreshThreadAccess()}
          >
            <RefreshCw size={14} />
            {checking ? "正在检查…" : "重试"}
          </button>
        </div>
      ) : (
        <div
          className="composer"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            add(e.dataTransfer.files);
          }}
        >
          <ComposerAnnotations />
          {preview && s.attachments.includes(preview) && (
            <AttachmentPreview
              attachment={preview}
              onClose={() => setPreview(null)}
            />
          )}
          {s.attachments.length > 0 && (
            <div className="attachment-list">
              {s.attachments.map((a) => (
                <div className="attachment" key={a.id}>
                  <button
                    type="button"
                    className="attachment-preview"
                    aria-label={"预览 " + a.name}
                    onClick={() => setPreview(a)}
                  >
                    {a.preview ? (
                      <img src={a.preview} />
                    ) : (
                      <Paperclip size={17} />
                    )}
                    <span>{a.name}</span>
                  </button>
                  <IconButton
                    icon={X}
                    title={"移除 " + a.name}
                    onClick={() =>
                      set({
                        attachments: s.attachments.filter((x) => x.id !== a.id),
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )}
          <MarkdownEditor
            key={s.current?.id || "new-" + s.backendId}
            inputRef={area}
            theme={s.theme}
            enlarged={enlarged}
            onEnlargedChange={setEnlarged}
            rows={2}
            expanded={shortcuts.open}
            activeId={shortcuts.open ? shortcuts.activeId : undefined}
            placeholder={
              compacting
                ? "正在整理上下文…"
                : s.goalMode
                  ? "描述目标，写明可衡量的完成条件…"
                  : active
                    ? backendCapability(s, "inputMode") === "queue"
                      ? "输入后排队执行…"
                      : "补充说明，或等待任务完成…"
                    : "描述任务，@ 引用文件，/ 使用命令…"
            }
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (document.activeElement?.closest?.(".cm-content"))
                shortcuts.close();
              else shortcuts.detect(e.target.value, e.target.selectionStart);
            }}
            onClick={(e) =>
              shortcuts.detect(e.target.value, e.target.selectionStart)
            }
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                shortcuts.detect(e.target.value, e.target.selectionStart);
            }}
            onPaste={(e) => {
              const images = [...e.clipboardData.files].filter((f) =>
                f.type.startsWith("image/"),
              );
              if (images.length) {
                e.preventDefault();
                add(images);
              }
            }}
            onKeyDown={(e) => {
              if (!e.target?.closest?.(".cm-content") && shortcuts.keydown(e))
                return;
              if (
                e.key === "Enter" &&
                e.ctrlKey &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <input
                type="file"
                ref={files}
                multiple
                hidden
                onChange={(e) => {
                  add(e.target.files);
                  e.target.value = "";
                }}
              />
              <IconButton
                icon={Plus}
                title="添加图片或文本附件"
                onClick={() => files.current.click()}
              />
              <ModelSelect />
              <ReasoningEffortControl />
              <ServiceTierToggle />
              <IconButton
                icon={ListChecks}
                title="计划模式"
                aria-pressed={s.mode === "plan"}
                active={s.mode === "plan"}
                onClick={() =>
                  set({
                    mode: s.mode === "plan" ? "default" : "plan",
                    goalMode: false,
                  })
                }
              />
            </div>
            <div className="send-controls">
              <IconButton
                icon={enlarged ? Minimize2 : Maximize2}
                title={enlarged ? "收起输入框" : "展开输入框"}
                data-composer-expand={!enlarged || undefined}
                aria-expanded={enlarged}
                onClick={() => {
                  setEnlarged(!enlarged);
                  area.current?.focus();
                }}
              />
              {s.goalMode && (
                <button
                  className="mode-badge"
                  title="退出目标输入"
                  onClick={() => set({ goalMode: false })}
                >
                  目标 <X size={12} />
                </button>
              )}
              {s.mode === "plan" && <span className="mode-badge">计划</span>}
              {active && (
                <button
                  className="stop-button"
                  aria-label="停止任务"
                  title="停止任务"
                  onClick={() => stop().catch(report)}
                >
                  <Square size={13} fill="currentColor" />
                </button>
              )}
              <button
                className="send-button"
                aria-label="发送消息"
                title="发送消息"
                disabled={
                  !s.connected ||
                  !backendReady(s) ||
                  checking ||
                  compacting ||
                  s.busy ||
                  s.goalBusy[s.current?.id] ||
                  (!draft.trim() &&
                    !s.attachments.length &&
                    !annotationDrafts.length)
                }
                onClick={submit}
              >
                {s.busy ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <ArrowUp size={19} />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="composer-meta">
        <button
          title={s.projectless ? "未指定项目；可选择文件夹" : s.cwd}
          onClick={() => set({ modal: { type: "directory" } })}
        >
          <Folder size={13} />
          <span>{s.projectless ? "未分类" : basename(s.cwd)}</span>
          <ChevronDown size={11} />
        </button>
        <span className="context-info">
          {usage != null ? (
            <>
              上下文 {usage.toLocaleString()} /{" "}
              {windowSize?.toLocaleString() ?? "—"} tokens
              {windowSize > 0 &&
                `（${Math.round((usage / windowSize) * 100)}%）`}
            </>
          ) : unavailable ? null : (
            "Ctrl + Enter 发送"
          )}
        </span>
      </div>
    </ComposerSurface>
  );
}
