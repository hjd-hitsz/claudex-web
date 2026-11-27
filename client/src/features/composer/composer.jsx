import { GoalSummary } from "./goal-summary.jsx";
import { ModelSelect } from "./model-select.jsx";
import { InputQueue } from "./input-queue.jsx";
import { backendReady, backendCapability } from "../../domain/backends.js";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  Archive,
  ArrowUp,
  Square,
  Plus,
  X,
  ChevronDown,
  LoaderCircle,
  Paperclip,
  Sparkles,
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
  get,
  set,
  setDraft,
  archive,
  refreshThreadAccess,
  stop,
  notice,
  report,
  attachFile,
  basename,
} from "../../store.js";
import { IconButton } from "../../ui/primitives.jsx";
import { useComposerShortcuts } from "../commands/shortcuts.jsx";
import { submitComposer } from "../commands/composer-commands.js";
import {
  DelegationToggle,
  setComposerDelegation,
} from "./delegation-toggle.jsx";
import { DelegationTarget } from "./delegation-target.jsx";
import { ServiceTierToggle } from "./service-tier-toggle.jsx";
import { ReasoningEffortControl } from "./reasoning-effort.jsx";
import { ComposerAnnotations } from "../annotations/message-annotations.jsx";
import { useAnnotationDrafts } from "../annotations/annotation-drafts.js";
import { isCompacting } from "../../domain/compaction.js";
import { CompactionStatus } from "./compaction-status.jsx";
import { ReferenceEditor } from "./reference-editor.jsx";
import { AttachmentPreview } from "./attachment-preview.jsx";
import { ComposerSurface } from "./composer-surface.jsx";
import { CodeFileAttachments } from "./code-file-attachments.jsx";
import { ComposerActivity } from "./composer-activity.jsx";
import { AgyContextUsage } from "./agy-context-usage.jsx";
import { sameDraftText } from "../../domain/code-line-reference.js";
export function Composer({ inputRef }) {
  const [preview, setPreview] = useState(null);
  const [enlarged, setEnlarged] = useState(false);
  const [matching, setMatching] = useState(false);
  const pendingSubmit = useRef(false);
  const s = useStore(),
    draft = useDraft(),
    localInput = useRef(),
    files = useRef();
  const area = inputRef ?? localInput;
  const focusAfterOpen = useRef(null);
  useEffect(() => setEnlarged(false), [s.current?.id, s.backendId, s.modal]);
  const annotationDrafts = useAnnotationDrafts(s.current?.id);
  const codeAttachments = s.attachments.filter((a) => a.kind === "code-line");
  const regularAttachments = s.attachments.filter(
    (a) => a.kind !== "code-line",
  );
  const shortcuts = useComposerShortcuts(area, submitAfterCodeLookup);
  const active = s.active[s.current?.id];
  const compaction = s.compactions[s.current?.id];
  const compacting = isCompacting(compaction);
  function submit() {
    if (area.current?.composing) return;
    shortcuts.close();
    return submitAfterCodeLookup(submitComposer);
  }
  async function submitAfterCodeLookup(send) {
    const editor = area.current;
    if (pendingSubmit.current || editor?.composing) return;
    const sources = editor?.waitForCodeSources?.();
    if (!sources) return send();
    const initial = get();
    pendingSubmit.current = true;
    setMatching(true);
    try {
      await sources;
      const current = get();
      if (
        area.current !== editor ||
        editor.composing ||
        current.current?.id !== initial.current?.id ||
        current.cwd !== initial.cwd ||
        current.backendId !== initial.backendId ||
        current.providerId !== initial.providerId ||
        current.goalMode !== initial.goalMode ||
        !current.connected
      )
        return;
      if (!sameDraftText(current.draft, initial.draft)) {
        notice("草稿已修改，请重新发送。");
        return;
      }
      return send();
    } finally {
      pendingSubmit.current = false;
      setMatching(false);
    }
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
  const archived = access?.status === "archived";
  const checking = s.loading || access?.status === "checking";
  const unavailable =
    s.loading ||
    (access && access.status !== "ready" && !(checking && access.background));
  useLayoutEffect(() => {
    if (s.loading) {
      focusAfterOpen.current = access?.threadId;
      return;
    }
    if (unavailable || enlarged) return;
    const target = focusAfterOpen.current;
    focusAfterOpen.current = null;
    const input = area.current;
    if (!target || target !== s.current?.id || s.modal || !input) return;
    const end = input.value.length;
    input.focus({ preventScroll: true });
    input.setSelectionRange(end, end);
  }, [
    s.loading,
    access?.threadId,
    unavailable,
    enlarged,
    s.current?.id,
    s.modal,
  ]);
  return (
    <ComposerSurface
      expanded={enlarged}
      inputRef={area}
      onClose={() => setEnlarged(false)}
    >
      <InputQueue />
      {backendCapability(s, "goal") && <GoalSummary />}
      {compaction && !compaction.dismissed && (
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
          ) : archived ? (
            <Archive size={20} />
          ) : (
            <AlertCircle size={20} />
          )}
          <div className="composer-access-content">
            <strong>
              {checking
                ? "正在检查对话状态…"
                : archived
                  ? "此对话已归档"
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
            aria-label={archived ? "恢复对话" : "重试连接对话"}
            disabled={!s.connected || checking}
            onClick={() =>
              archived
                ? archive(s.current).catch(report)
                : refreshThreadAccess()
            }
          >
            {archived ? <Archive size={14} /> : <RefreshCw size={14} />}
            {checking ? "正在检查…" : archived ? "恢复对话" : "重试"}
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
          <ComposerAnnotations onSubmit={submit} />
          <CodeFileAttachments
            attachments={codeAttachments}
            onRemove={(id) => {
              if (!area.current?.removeCodeSource?.(id))
                set({
                  attachments: get().attachments.filter((a) => a.id !== id),
                });
            }}
          />
          {preview && s.attachments.includes(preview) && (
            <AttachmentPreview
              attachment={preview}
              onClose={() => setPreview(null)}
            />
          )}
          {regularAttachments.length > 0 && (
            <div className="attachment-list">
              {regularAttachments.map((a) => (
                <div className="attachment" key={a.id}>
                  <button
                    type="button"
                    className="attachment-preview"
                    aria-label={"预览 " + a.name}
                    onClick={() => {
                      if (s.backendId === "agy" && a.input?.type === "skill") {
                        set({
                          panel: "files",
                          panelFile: { kind: "file", path: a.input.path },
                        });
                      } else setPreview(a);
                    }}
                  >
                    {a.preview ? (
                      <img src={a.preview} alt="" />
                    ) : a.input?.type === "skill" ? (
                      <Sparkles size={17} />
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
          <ReferenceEditor
            key={s.current?.id || "new-" + s.backendId}
            inputRef={area}
            codeAttachments={codeAttachments}
            onCodeSourcesChange={(active) =>
              set({
                attachments: [
                  ...get().attachments.filter((a) => a.kind !== "code-line"),
                  ...active,
                ],
              })
            }
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
                    ? s.backendId === "agy"
                      ? "补充说明将在下一次模型请求生效…"
                      : backendCapability(s, "inputMode") === "queue"
                        ? "输入后排队执行…"
                        : "补充说明，或等待任务完成…"
                    : "描述任务，@ 引用文件，/ 使用命令…"
            }
            value={draft}
            onValueChange={setDraft}
            onCompositionStart={shortcuts.clear}
            onCursorActivity={(text, position) => {
              if (position === null) shortcuts.clear();
              else shortcuts.detect(text, position);
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
              if (e.key === "Enter" && e.ctrlKey && !e.shiftKey) {
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
              {s.backendId === "agy" ? (
                <DelegationTarget />
              ) : (
                <ServiceTierToggle />
              )}
              <DelegationToggle />
              {s.backendId !== "agy" && (
                <IconButton
                  icon={ListChecks}
                  title="计划模式"
                  aria-pressed={s.mode === "plan"}
                  active={s.mode === "plan"}
                  onClick={() =>
                    setComposerDelegation({
                      mode: s.mode === "plan" ? "default" : "plan",
                      goalMode: false,
                      delegationMode: false,
                    })
                  }
                />
              )}
              <ComposerActivity
                items={s.items}
                expanded={s.contextOpen && !s.panel}
                onToggle={() => {
                  setEnlarged(false);
                  set({
                    panel: null,
                    contextOpen: !s.contextOpen || Boolean(s.panel),
                  });
                }}
              />
            </div>
            <div className="send-controls">
              <IconButton
                icon={enlarged ? Minimize2 : Maximize2}
                title={enlarged ? "收起输入框" : "展开输入框"}
                data-composer-expand={!enlarged || undefined}
                aria-expanded={enlarged}
                onClick={() => setEnlarged(!enlarged)}
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
              {s.backendId !== "agy" && s.mode === "plan" && (
                <span className="mode-badge">计划</span>
              )}
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
                title={matching ? "正在匹配代码文件…" : "发送消息"}
                disabled={
                  !s.connected ||
                  !backendReady(s) ||
                  checking ||
                  compacting ||
                  matching ||
                  s.busy ||
                  s.goalBusy[s.current?.id] ||
                  (!draft.trim() &&
                    !s.attachments.length &&
                    !annotationDrafts.length)
                }
                onClick={submit}
              >
                {s.busy || matching ? (
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
        {!matching && s.backendId === "agy" && token ? (
          <AgyContextUsage
            key={s.current?.id}
            token={token}
            turns={s.turns[s.current?.id]}
          />
        ) : (
          <span className="context-info" role={matching ? "status" : undefined}>
            {matching ? (
              "正在匹配代码文件…"
            ) : usage != null ? (
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
        )}
      </div>
    </ComposerSurface>
  );
}
