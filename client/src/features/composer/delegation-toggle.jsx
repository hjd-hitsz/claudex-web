import React from "react";
import { Forward } from "lucide-react";
import { get, report, rpc, set, useStoreSelector } from "../../store.js";
import {
  acceptsDelegation,
  nativeDelegationTarget,
} from "../../domain/delegation.js";
import { IconButton } from "../../ui/primitives.jsx";

export async function setComposerDelegation(patch) {
  const { current, delegationMode } = get();
  const threadId = current?.id;
  if (threadId && delegationMode !== patch.delegationMode) {
    set({ busy: true });
    try {
      await rpc("lan/delegation/mode/set", {
        threadId,
        delegationMode: patch.delegationMode,
      });
    } catch (error) {
      report(error);
      return;
    } finally {
      set({ busy: false });
    }
    if (get().current?.id !== threadId) return;
  }
  set(patch);
}

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
    ? `委派模式已${active ? "开启" : "关闭"} · ${target.name}`
    : "启用 " + target.name + " 的接收委派后可用";
  return (
    <IconButton
      icon={Forward}
      type="button"
      title={title}
      aria-label="委派模式"
      aria-pressed={active}
      active={active}
      disabled={busy || (!available && !active)}
      onClick={() =>
        setComposerDelegation({
          delegationMode: !active,
          ...(!active && { mode: "default", goalMode: false }),
        })
      }
    />
  );
}
