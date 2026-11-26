import React from "react";
import { IconButton } from "../../ui/primitives.jsx";
import { set, useStore } from "../../store.js";
import {
  delegationTargets,
  selectedDelegate,
} from "../../domain/delegation.js";
import { BackendBadge } from "../backends/backend-badge.jsx";

export function DelegationTarget() {
  const state = useStore();
  const targets = delegationTargets(state);
  const id = selectedDelegate(state);
  const selected = targets.find((target) => target.id === id);
  if (!selected) return null;
  const next = targets.find((target) => target.id !== id);
  const label = `本轮委派：${selected.name}`;
  return (
    <IconButton
      type="button"
      icon={() => <BackendBadge backendId={id} />}
      title={next ? `${label}，点击切换为 ${next.name}` : label}
      aria-label={label}
      disabled={!next}
      onClick={() => set({ agyDelegateTo: next.id })}
    />
  );
}
