import { useEffect, useId, useRef, useState } from "react";

export function useDismissibleMenu() {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const menu = useRef(null);
  const id = useId();

  function contains(target) {
    return trigger.current?.contains(target) || menu.current?.contains(target);
  }

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event) => {
      if (!contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  return {
    open,
    close,
    dismiss: () => setOpen(false),
    triggerProps: {
      ref: trigger,
      "aria-expanded": open,
      "aria-controls": open ? id : undefined,
      onClick: () => setOpen(!open),
    },
    menuProps: { ref: menu, id },
    scopeProps: {
      onBlur(event) {
        if (open && !contains(event.relatedTarget)) setOpen(false);
      },
      onKeyDown(event) {
        if (!open || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      },
    },
  };
}
