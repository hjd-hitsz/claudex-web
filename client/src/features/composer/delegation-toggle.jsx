import React from "react";
import { Forward } from "lucide-react";
import { set, useStoreSelector } from "../../store.js";
import {
  acceptsDelegation,
  nativeDelegationTarget,
} from "../../domain/delegation.js";
import { IconButton } from "../../ui/primitives.jsx";

export function DelegationToggle() {
  const target = useStoreSelector(nativeDelegationTarget);
  const active = useStoreSelector((state) => state.delegationMode);
  const busy = useStoreSelector(
    (state) => state.busy || Boolean(state.active[state.current?.id]),
  );
  const receiving = useStoreSelector((state) =>
    acceptsDelegation(state, target?.id),
  );
  if (!target) return null;
  const available = target.enabled && receiving;
  const title = available
    ? "委派模式 · " + target.name
    : "启用 " + target.name + " 的接收委派后可用";
  return (
    <IconButton
      icon={Forward}
      type="button"
      title={title}
      aria-label="委派模式"
      aria-pressed={active && available}
      active={active && available}
      disabled={busy || !available}
      onClick={() =>
        set(
          active
            ? { delegationMode: false }
            : { delegationMode: true, mode: "default", goalMode: false },
        )
      }
    />
  );
}
