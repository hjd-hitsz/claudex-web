import React from "react";
import { Forward } from "lucide-react";
import {
  get,
  loadThreads,
  notice,
  openThread,
  report,
  rpc,
  set,
  setDraft,
  useStoreSelector,
} from "../../store.js";
import {
  canUseNativeDelegation,
  nativeDelegationTarget,
} from "../../domain/delegation.js";
import { IconButton } from "../../ui/primitives.jsx";

export const secretaryHistoryScope =
  "续接可见对话。原生压缩摘要、目标、后台运行、撤销检查点、用量和原始附件保留在原对话。";

export async function setComposerDelegation(patch) {
  const { current, delegationMode, model } = get();
  const threadId = current?.id;
  const upgrading = current?.secretaryContinuationRequired === true;
  if (threadId && (upgrading || delegationMode !== patch.delegationMode)) {
    set({ busy: true });
    try {
      const result = await rpc("lan/delegation/mode/set", {
        threadId,
        delegationMode: patch.delegationMode,
        ...(model && { model }),
      });
      if (result.thread && get().current?.id === threadId) {
        const { draft } = get();
        await openThread(result.thread.id, {
          forkResult: result,
          preserveServiceTier: true,
        });
        if (get().current?.id !== result.thread.id) return;
        if (draft && !get().draft) setDraft(draft);
        notice("已创建秘书续接。" + secretaryHistoryScope, 12000);
        await loadThreads();
        return;
      }
      if (
        upgrading &&
        !patch.delegationMode &&
        get().current?.id === threadId
      ) {
        await openThread(threadId, { preserveServiceTier: true });
        return;
      }
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
  const available = useStoreSelector(canUseNativeDelegation);
  if (!target) return null;
  const title =
    target.enabled && target.ready === false
      ? `${target.name} 尚未连接`
      : available
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
