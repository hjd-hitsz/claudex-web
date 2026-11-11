import { ServiceMaintenanceSettings } from "./service-maintenance.jsx";
import { BackendSettings } from "./backend-settings.jsx";
import React from "react";
import { Check } from "lucide-react";
import { useStore, set, selectModel } from "../store.js";
import { ServiceTierToggle } from "../features/composer/service-tier-toggle.jsx";
import { ReasoningEffortControl } from "../features/composer/reasoning-effort.jsx";
import { LogoutButton } from "./auth.jsx";
import { TranslationSettings } from "./translation-settings.jsx";
import { NotificationSettings } from "./notification-settings.jsx";
export function SettingsDialog() {
  const s = useStore();
  return (
    <div className="settings-body">
      <ServiceMaintenanceSettings focus={s.modal?.section === "maintenance"} />
      <BackendSettings />
      <section
        className="settings-section"
        aria-labelledby="preferences-settings-title"
      >
        <h3 id="preferences-settings-title">通知与翻译</h3>
        <div className="settings-group settings-preferences">
          <NotificationSettings />
          <TranslationSettings />
        </div>
      </section>
      <section
        className="settings-section"
        aria-labelledby="login-settings-title"
      >
        <h3 id="login-settings-title">网页登录</h3>
        <div className="settings-group">
          <LogoutButton />
        </div>
      </section>
    </div>
  );
}
export function ModelDialog() {
  const s = useStore();
  return (
    <div className="settings-body">
      <p className="section-description">设置应用于下一条消息。</p>
      <div className="model-options">
        {s.models.map((m) => (
          <button
            key={m.id}
            className={m.model === s.model ? "selected" : ""}
            onClick={() => selectModel(m)}
          >
            <span>
              <b>{m.displayName || m.model}</b>
              <small>{m.description}</small>
            </span>
            {m.model === s.model && <Check size={17} />}
          </button>
        ))}
      </div>
      <ReasoningEffortControl inline />
      <h3>速度模式</h3>
      <ServiceTierToggle />
      <p className="section-description">Fast 模式会增加用量。</p>
      <div className="dialog-done">
        <button className="primary" onClick={() => set({ modal: null })}>
          完成
        </button>
      </div>
    </div>
  );
}
