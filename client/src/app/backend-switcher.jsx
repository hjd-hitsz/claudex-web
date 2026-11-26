import React from "react";
import { HeaderSwitcher } from "./header-switcher.jsx";
import { BackendBadge } from "../features/backends/backend-badge.jsx";
import { currentBackendId } from "../domain/backends.js";
import { report, switchBackend } from "../store.js";

export function BackendSwitcher({ state }) {
  const current = currentBackendId(state);
  const backend = state.backends.find(({ id }) => id === current);
  const name = backend?.name || "Codex";
  return (
    <HeaderSwitcher
      className="backend-switcher"
      label={name}
      icon={<BackendBadge backendId={current} />}
      iconOnly
      title={`切换后端 · ${name}`}
      triggerLabel={`切换后端，当前为 ${name}`}
      groupLabel="切换后端"
      emptyLabel="暂无已启用的后端"
      current={current}
      getOptions={() =>
        state.backends
          .filter(({ enabled }) => enabled)
          .map(({ id, name, ready }) => ({
            value: id,
            label: name,
            detail: ready === false ? "未连接" : undefined,
            disabled: ready === false || state.busy || state.loading,
            icon: <BackendBadge backendId={id} />,
          }))
      }
      onSelect={(id) => switchBackend(id).catch(report)}
    />
  );
}
