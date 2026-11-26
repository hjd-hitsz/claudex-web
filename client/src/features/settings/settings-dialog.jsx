import React, { useLayoutEffect, useRef, useState } from "react";
import { Database, Layers, Link, RefreshCw, Settings, X } from "lucide-react";
import productIcon from "../../assets/claudex-web.svg";
import { useStoreSelector } from "../../store.js";
import { IconButton } from "../../ui/primitives.jsx";
import { ServiceMaintenanceSettings } from "./service-maintenance.jsx";
import { BackgroundTerminalSetting } from "./background-terminal-setting.jsx";
import { BackendSettings } from "./backend-settings.jsx";
import { ProviderSettings } from "./provider-settings.jsx";
import { TranslationSettings } from "./translation-settings.jsx";
import { NotificationSettings } from "./notification-settings.jsx";
import { P2pSettings } from "./p2p-settings.jsx";

const pages = [
  { id: "general", title: "通用", Icon: Settings },
  { id: "backends", title: "后端", Icon: Layers },
  { id: "providers", title: "模型服务商", Icon: Database },
  { id: "connection", title: "连接与登录", Icon: Link },
  { id: "maintenance", title: "更新与重启", Icon: RefreshCw },
];

export function SettingsDialog({
  focusMaintenance,
  onClose,
  accountActions,
  certificateHelp,
}) {
  const [active, setActive] = useState(
    focusMaintenance ? "maintenance" : "general",
  );
  const [visited, setVisited] = useState(() => new Set([active]));
  const [providerActions, setProviderActions] = useState(null);
  const body = useRef(null);
  const scrollPositions = useRef(new Map());
  const page = pages.find(({ id }) => id === active);

  useLayoutEffect(() => {
    body.current.scrollTop = scrollPositions.current.get(active) ?? 0;
  }, [active]);

  function select(id) {
    if (id === active) return;
    scrollPositions.current.set(active, body.current.scrollTop);
    if (!visited.has(id)) setVisited(new Set([...visited, id]));
    setActive(id);
  }

  return (
    <div className="settings-shell">
      <div className="settings-rail">
        <div className="settings-brand">
          <img src={productIcon} width="28" height="28" alt="" />
          <span>设置</span>
        </div>
        <select
          className="settings-compact-navigation"
          aria-label="设置分类"
          data-dialog-focus={!focusMaintenance ? "" : undefined}
          value={active}
          onChange={(event) => select(event.target.value)}
        >
          {pages.map(({ id, title }) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
        <nav className="settings-navigation" aria-label="设置分类">
          {pages.map(({ id, title, Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={active === id ? "page" : undefined}
              data-dialog-focus={
                active === id && !focusMaintenance ? "" : undefined
              }
              onClick={() => select(id)}
            >
              <Icon aria-hidden="true" />
              <span>{title}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="settings-page">
        <header className="settings-page-heading">
          <h2
            id={`settings-${page.id}-title`}
            tabIndex={-1}
            data-dialog-focus={focusMaintenance ? "" : undefined}
          >
            {page.title}
          </h2>
          <div ref={setProviderActions} hidden={active !== "providers"} />
        </header>
        <div className="settings-body" ref={body}>
          {visited.has("general") && (
            <div hidden={active !== "general"}>
              <GeneralSettings />
            </div>
          )}
          {visited.has("backends") && (
            <div hidden={active !== "backends"}>
              <BackendSettings visible={active === "backends"} />
            </div>
          )}
          {visited.has("providers") && (
            <div hidden={active !== "providers"}>
              <ProviderSettings actionTarget={providerActions} />
            </div>
          )}
          {visited.has("connection") && (
            <div hidden={active !== "connection"}>
              <ConnectionSettings
                active={active === "connection"}
                accountActions={accountActions}
                certificateHelp={certificateHelp}
              />
            </div>
          )}
          {visited.has("maintenance") && (
            <div hidden={active !== "maintenance"}>
              <ServiceMaintenanceSettings />
            </div>
          )}
        </div>
      </div>
      <IconButton
        icon={X}
        title="关闭窗口"
        className="settings-close"
        onClick={onClose}
      />
    </div>
  );
}

function GeneralSettings() {
  const codex = useStoreSelector((state) =>
    state.backends.find((backend) => backend.id === "codex"),
  );
  return (
    <section
      className="settings-group settings-preferences"
      aria-labelledby="settings-general-title"
    >
      <NotificationSettings />
      <TranslationSettings />
      <BackgroundTerminalSetting backend={codex} />
    </section>
  );
}

function ConnectionSettings({ active, accountActions, certificateHelp }) {
  const remote = useStoreSelector((state) => state.auth?.kind === "p2p");
  return (
    <section
      className="connection-cards"
      aria-labelledby="settings-connection-title"
    >
      <section
        className="settings-group"
        aria-labelledby="account-settings-title"
      >
        <div>
          <h4 className="connection-heading" id="account-settings-title">
            账号与双重验证
          </h4>
          {accountActions}
        </div>
      </section>
      {!remote && (
        <>
          <section
            className="settings-group"
            aria-labelledby="certificate-settings-title"
          >
            <div>
              <h4
                className="connection-heading"
                id="certificate-settings-title"
              >
                局域网 HTTPS 证书
              </h4>
              {certificateHelp}
            </div>
          </section>
          <section
            className="settings-group"
            aria-labelledby="p2p-settings-title"
          >
            <P2pSettings active={active} />
          </section>
        </>
      )}
    </section>
  );
}
