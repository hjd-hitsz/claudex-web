import React from "react";
import { useStore, selectBackend, report } from "../store.js";
import { currentBackendId } from "../domain/backends.js";
import { BackendBadge } from "../features/backends/backend-badge.jsx";
import { HeaderSwitcher } from "./header-switcher.jsx";

export function BackendSwitcher() {
  const state = useStore();
  const current = currentBackendId(state);
  const name = state.backends.find((b) => b.id === current)?.name || current;
  return (
    <HeaderSwitcher
      className="backend-switcher"
      label={<BackendBadge backendId={current} />}
      triggerLabel={`切换后端，当前为 ${name}`}
      title={`切换后端：${name}`}
      groupLabel="后端"
      emptyLabel="请在设置中启用后端"
      current={current}
      disabled={state.busy || state.loading}
      getOptions={() =>
        state.backends
          .filter((b) => b.enabled)
          .map((b) => ({
            value: b.id,
            label: b.name,
            icon: <BackendBadge backendId={b.id} />,
            description:
              state.current && b.id !== current
                ? `在当前目录开始 ${b.name} 新对话`
                : undefined,
          }))
      }
      onSelect={(id) => selectBackend(id).catch(report)}
    />
  );
}
