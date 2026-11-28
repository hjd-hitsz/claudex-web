import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export function UsageRoundPicker({ options, selected, onSelect }) {
  const id = useId();
  const trigger = useRef(null);
  const list = useRef(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState("");
  const selectedIndex = options.indexOf(selected);
  const index = options.findIndex(({ value }) => value === highlighted);
  const active = index < 0 ? Math.max(0, selectedIndex) : index;

  useLayoutEffect(() => {
    if (open)
      list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function choose(option) {
    if (option) onSelect(option.value);
    setOpen(false);
    trigger.current?.focus();
  }

  function navigate(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = open
        ? Math.max(0, Math.min(options.length - 1, active + offset))
        : Math.max(0, selectedIndex);
      setHighlighted(options[next].value);
      setOpen(true);
    } else if (open && event.key === "Enter") {
      event.preventDefault();
      choose(options[active]);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      choose();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="usage-round-picker">
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label="选择用量轮次"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        title={selected.title}
        onKeyDown={navigate}
        onClick={() => {
          setHighlighted(selected.value);
          setOpen(!open);
        }}
      >
        <span>{selected.label}</span>
        <span>{selected.context}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <ul ref={list} id={id} role="listbox" aria-label="轮次上下文用量">
          {options.map(({ value, label, context, title }, index) => (
            <li
              key={value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={value === selected.value}
              data-turn-id={value}
              data-highlighted={index === active}
              title={title}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(options[index])}
            >
              <span>{label}</span>
              <span>{context}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
