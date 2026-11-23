import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export function HeaderSwitcher({
  as: Container = "div",
  className,
  label,
  triggerLabel,
  groupLabel,
  title = label,
  compactIcon,
  emptyLabel,
  current,
  getOptions,
  onSelect,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const container = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const focusEdge = useRef(null);
  const id = useId();
  const options = open ? getOptions() : [];

  useEffect(() => {
    if (!open) return;
    if (focusEdge.current) {
      panel.current.querySelector(focusEdge.current)?.focus();
      focusEdge.current = null;
    }
    function closeOnOutsidePress(event) {
      if (!container.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current.focus();
  }

  function handleKeyDown(event) {
    if (open && event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const down = event.key === "ArrowDown";
    if (!open) {
      if (event.key !== "ArrowUp" && !down) return;
      event.preventDefault();
      focusEdge.current = down ? "button:first-child" : "button:last-child";
      setOpen(true);
      return;
    }
    event.preventDefault();
    const buttons = [...panel.current.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "Home") buttons[0]?.focus();
    else if (event.key === "End") buttons.at(-1)?.focus();
    else if (down) (buttons[index + 1] || buttons[0])?.focus();
    else (buttons[index - 1] || buttons.at(-1))?.focus();
  }

  return (
    <Container
      className={`header-switcher ${className}`}
      ref={container}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        disabled={disabled}
        ref={trigger}
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={title}
        onClick={() => {
          trigger.current.focus();
          setOpen(!open);
        }}
      >
        {compactIcon}
        <span>{label}</span>
        <ChevronDown
          className="switcher-chevron"
          size={12}
          aria-hidden="true"
        />
      </button>
      {open && (
        <span
          id={id}
          ref={panel}
          className="dropdown header-switcher-options"
          role="group"
          aria-label={groupLabel}
        >
          {options.length === 0 && (
            <span className="header-switcher-empty" role="status">
              {emptyLabel}
            </span>
          )}
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              title={option.title || option.label}
              aria-description={option.description}
              aria-current={option.value === current || undefined}
              onClick={() => {
                close();
                if (option.value !== current) onSelect(option.value);
              }}
            >
              {option.icon}
              <span className="header-switcher-option-label">
                <span>{option.label}</span>
                {option.detail && <small>{option.detail}</small>}
              </span>
              {option.value === current && (
                <Check
                  className="header-switcher-check"
                  size={14}
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </span>
      )}
    </Container>
  );
}
