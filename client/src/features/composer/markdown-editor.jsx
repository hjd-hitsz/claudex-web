import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorFrame } from "./editor-frame.jsx";
import {
  isCaretMovementKey,
  isCompositionInput,
  isCompositionKey,
  protectCompositionInput,
  protectCompositionKey,
} from "./document-composition.js";

export function MarkdownEditor({
  value,
  onValueChange,
  onCursorActivity,
  onCompositionStart,
  onKeyDown,
  onPaste,
  inputRef,
  theme,
  expanded,
  activeId,
  enlarged,
  onEnlargedChange,
  fill = false,
  file = false,
  configure,
  referenceSkills,
  onOpenReference,
  codeAttachments,
  findCodeLine,
  onCodeSourcesChange,
  ...inputProps
}) {
  const label = inputProps["aria-label"] || "消息";
  const { placeholder } = inputProps;
  const mount = useRef();
  const fallback = useRef();
  const editor = useRef();
  const latest = useRef();
  const committed = useRef(value);
  const composition = useRef(null);
  const promote = useRef(null);
  const pendingSelection = useRef(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [composing, setComposing] = useState(false);
  const [fallbackText, setFallbackText] = useState(null);
  latest.current = {
    value,
    placeholder,
    referenceSkills,
    onOpenReference,
    codeAttachments,
    onCodeSourcesChange,
    onValueChange,
    onCursorActivity,
  };

  const handle = useMemo(
    () => ({
      focus(options) {
        if (editor.current) editor.current.focus();
        else fallback.current?.focus(options);
      },
      setSelectionRange(start, end = start) {
        if (composition.current) return;
        if (editor.current) editor.current.setCursor(start, end);
        else fallback.current?.setSelectionRange(start, end);
      },
      get replaceText() {
        return editor.current?.replaceText;
      },
      get insertReference() {
        return editor.current?.insertReference;
      },
      removeCodeSource: (id) => editor.current?.removeCodeSource(id),
      waitForCodeSources: () => editor.current?.waitForCodeSources(),
      get composing() {
        return Boolean(composition.current);
      },
      get value() {
        return committed.current;
      },
      get selectionStart() {
        return editor.current?.getCursor() ?? fallback.current?.selectionStart;
      },
      get selectionEnd() {
        return (
          editor.current?.getCursor(true) ?? fallback.current?.selectionEnd
        );
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    inputRef.current = handle;
    return () => {
      composition.current = null;
      if (inputRef.current === handle) inputRef.current = null;
    };
  }, [inputRef, handle]);

  function cursorActivity() {
    const notify = latest.current.onCursorActivity;
    if (!notify || composition.current) return;
    const surface = editor.current?.dom ?? fallback.current;
    const inText = surface && surface.ownerDocument.activeElement === surface;
    notify(committed.current, inText ? handle.selectionStart : null);
  }

  function selectionActivity() {
    if (composition.current) return;
    editor.current?.syncSelection();
    cursorActivity();
  }

  function publish(text) {
    if (text === committed.current) return;
    committed.current = text;
    latest.current.onValueChange(text);
  }

  function applyExternal(text) {
    if (text === committed.current) return;
    committed.current = text;
    editor.current?.setText(text);
  }

  function startComposition(event) {
    if (composition.current) return;
    const target = event.target;
    const value = committed.current;
    composition.current = { target, text: value };
    if (target === fallback.current) setFallbackText(target.value);
    setComposing(true);
    onCompositionStart?.();
  }

  function finishComposition(target, format = false, text) {
    const active = composition.current;
    if (active?.target !== target) return;
    // ProseMirror flushes the final native DOM mutations after compositionend.
    queueMicrotask(() => {
      if (composition.current !== active) return;
      editor.current?.finishComposition(text, format);
      const next =
        active.target === fallback.current ? active.target.value : active.text;
      composition.current = null;
      if (next !== committed.current) publish(next);
      else applyExternal(latest.current.value);
      setFallbackText(null);
      setComposing(false);
      cursorActivity();
      promote.current?.();
    });
  }

  function keydown(event, forward = true) {
    if (
      protectCompositionKey(event, composition.current !== null) ||
      event.defaultPrevented
    )
      return;
    if (forward) onKeyDown?.(event);
    if (event.defaultPrevented) event.stopPropagation?.();
  }

  function keyup(event) {
    if (isCaretMovementKey(event.key) && !isCompositionKey(event.nativeEvent))
      selectionActivity();
  }

  const beforeInput = useCallback((event) => {
    protectCompositionInput(
      event,
      composition.current?.target === event.target,
    );
  }, []);
  const registerFallback = useCallback(
    (node) => {
      fallback.current = node;
      node?.addEventListener("beforeinput", beforeInput, true);
      return () => {
        node?.removeEventListener("beforeinput", beforeInput, true);
        fallback.current = null;
      };
    },
    [beforeInput],
  );
  const registerMount = useCallback(
    (node) => {
      mount.current = node;
      node?.addEventListener("beforeinput", beforeInput, true);
      return () => {
        node?.removeEventListener("beforeinput", beforeInput, true);
        mount.current = null;
      };
    },
    [beforeInput],
  );

  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    let instance;
    let restoringSources = false;
    function restoreSources() {
      if (!latest.current.onCodeSourcesChange) return;
      const attached = latest.current.codeAttachments ?? [];
      restoringSources = true;
      try {
        const active = instance.restoreCodeSources(attached);
        if (
          active.length !== attached.length ||
          active.some((entry, index) => entry !== attached[index])
        )
          latest.current.onCodeSourcesChange(active);
      } finally {
        restoringSources = false;
      }
    }
    import("./document-editor.js")
      .then(async ({ createDocumentEditor }) => {
        if (disposed) return;
        const initialValue = committed.current;
        const startedFocused = document.activeElement === fallback.current;
        instance = await createDocumentEditor(mount.current, {
          value: initialValue,
          placeholder: latest.current.placeholder,
          file,
          configure,
          referenceSkills: latest.current.referenceSkills,
          findCodeLine,
          onCodeSourcesChange: onCodeSourcesChange
            ? (attachments) => {
                if (!disposed && !restoringSources)
                  latest.current.onCodeSourcesChange?.(attachments);
              }
            : undefined,
          onOpenReference(reference) {
            if (!disposed) latest.current.onOpenReference?.(reference);
          },
          onChange(text) {
            if (disposed || !editor.current) return;
            if (composition.current) {
              composition.current.text = text;
              return;
            }
            publish(text);
            cursorActivity();
          },
        });
        if (disposed) {
          await instance.destroy();
          return;
        }
        promote.current = () => {
          promote.current = null;
          const previous = fallback.current;
          const focused =
            document.activeElement === previous ||
            (startedFocused && document.activeElement === document.body);
          if (focused)
            pendingSelection.current = [
              previous.selectionStart,
              previous.selectionEnd,
            ];
          editor.current = instance;
          if (committed.current !== initialValue)
            instance.setText(committed.current);
          restoreSources();
          setReady(true);
        };
        // The textarea keeps its native composition and selection until it settles.
        if (!composition.current) promote.current();
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      promote.current = null;
      editor.current = null;
      instance?.destroy();
    };
  }, []);
  useLayoutEffect(() => {
    if (!composition.current) applyExternal(value);
  }, [value]);
  useLayoutEffect(() => {
    if (!ready || !pendingSelection.current) return;
    const [start, end] = pendingSelection.current;
    pendingSelection.current = null;
    handle.focus();
    handle.setSelectionRange(start, end);
  }, [ready, handle]);
  useEffect(() => {
    if (referenceSkills) editor.current?.setReferenceSkills(referenceSkills);
  }, [ready, referenceSkills]);
  useEffect(() => {
    if (!ready || composition.current) return;
    editor.current.setAttributes({
      role: "textbox",
      "aria-label": label,
      "aria-multiline": "true",
      ...(!file && {
        "aria-autocomplete": "list",
        "aria-expanded": String(expanded),
      }),
      ...(activeId ? { "aria-activedescendant": activeId } : {}),
      "data-placeholder": placeholder,
    });
  }, [ready, composing, expanded, activeId, placeholder, label, file]);

  const compositionEvents = {
    onCompositionStart: startComposition,
    onCompositionEnd: (event) =>
      finishComposition(event.target, true, event.data),
    onInput: (event) => {
      // Chromium can lose compositionend when a multi-block selection is replaced.
      const input = event.nativeEvent;
      if (input.isComposing === false && !isCompositionInput(input))
        finishComposition(event.target, true, input.data);
    },
    onBlur: (event) => finishComposition(event.target),
  };
  const Frame = fill ? "div" : EditorFrame;
  const frameProps = fill
    ? { className: "markdown-composer" }
    : { value, ready, expanded: enlarged, onExpandedChange: onEnlargedChange };
  return (
    <Frame {...frameProps}>
      {!ready && (
        <textarea
          {...inputProps}
          {...compositionEvents}
          ref={registerFallback}
          aria-label={label}
          aria-autocomplete={file ? undefined : "list"}
          aria-expanded={expanded}
          aria-activedescendant={activeId}
          value={fallbackText ?? value}
          rows={2}
          onChange={(event) => {
            const text = event.target.value;
            if (composition.current) setFallbackText(text);
            else {
              publish(text);
              cursorActivity();
            }
          }}
          onKeyDown={keydown}
          onKeyUp={keyup}
          onClick={selectionActivity}
          onPaste={onPaste}
        />
      )}
      {failed && (
        <span role="status">编辑器加载失败，可继续输入 Markdown。</span>
      )}
      <div
        {...compositionEvents}
        ref={registerMount}
        className="document-editor-viewport"
        hidden={!ready}
        onKeyDownCapture={(event) => {
          if (ready)
            keydown(event, !event.target.closest("input, textarea, button"));
        }}
        onPasteCapture={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) event.stopPropagation();
        }}
        onClick={selectionActivity}
        onKeyUp={keyup}
      />
    </Frame>
  );
}
