import { ServiceMaintenanceSettings } from "./service-maintenance.jsx";
import { BackgroundTerminalSetting } from "./background-terminal-setting.jsx";
import { BackendSettings } from "./backend-settings.jsx";
import React from "react";
import { useStoreSelector } from "../../store.js";
import { TranslationSettings } from "./translation-settings.jsx";
import { NotificationSettings } from "./notification-settings.jsx";
import { P2pSettings } from "./p2p-settings.jsx";
export function SettingsDialog({ focusMaintenance, accountActions }) {
  const codex = useStoreSelector((state) =>
    state.backends.find((backend) => backend.id === "codex"),
  );
  const remote = useStoreSelector((state) => state.auth?.kind === "p2p");
  return (
    <div className="settings-body">
      <ServiceMaintenanceSettings focus={focusMaintenance} />
      <BackendSettings />
      <section
        className="settings-section"
        aria-labelledby="preferences-settings-title"
      >
        <h3 id="preferences-settings-title">其他设置</h3>
        <div className="settings-group settings-preferences">
          <NotificationSettings />
          <TranslationSettings />
          <BackgroundTerminalSetting backend={codex} />
        </div>
      </section>
      <section
        className="settings-section"
        aria-labelledby="login-settings-title"
      >
        <h3 id="login-settings-title">连接与登录</h3>
        <div className="settings-group">
          {accountActions}
          {!remote && <P2pSettings />}
        </div>
      </section>
    </div>
  );
}
