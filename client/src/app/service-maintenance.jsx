import productIcon from "../assets/claudex-web.svg";
import { ArrowUpCircle, ChevronRight, RefreshCw } from "lucide-react";
import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { serviceMaintenance } from "../application/service-maintenance.js";
import { set, useStore } from "../store.js";
function useMaintenance() {
  return useSyncExternalStore(
    serviceMaintenance.subscribe,
    serviceMaintenance.get,
  );
}
export function ServiceUpdateNotice() {
  useEffect(() => serviceMaintenance.start(), []);
  const { refreshNeeded } = useMaintenance();
  const { modal } = useStore();
  if (refreshNeeded && modal?.type !== "settings")
    return (
      <div className="connection-banner" role="status">
        服务已重启，请刷新网页。
      </div>
    );
  return null;
}
export function ServiceUpdateEntry({ compact = false }) {
  const { status, refreshNeeded } = useMaintenance();
  if (!status?.updateAvailable || refreshNeeded) return null;
  return (
    <button
      className={
        compact
          ? "service-update-entry service-update-header"
          : "service-update-entry service-update-sidebar"
      }
      aria-label={`发现新版本 ${status.latest}`}
      onClick={() =>
        set({ modal: { type: "settings", section: "maintenance" } })
      }
    >
      <ArrowUpCircle size={17} aria-hidden="true" />
      <span>{compact ? "有更新" : "发现新版本"}</span>
      {!compact && <small>{status.latest}</small>}
      {!compact && <ChevronRight size={14} aria-hidden="true" />}
    </button>
  );
}
export function ServiceMaintenanceSettings({ focus = false }) {
  const section = useRef(null);
  useEffect(() => {
    void serviceMaintenance.request();
    return () => serviceMaintenance.dismissFeedback();
  }, []);
  const heading = useRef(null);
  useEffect(() => {
    if (focus) {
      section.current?.scrollIntoView({ block: "center" });
      heading.current?.focus({ preventScroll: true });
    }
  }, [focus]);
  const { status, pending, pendingAction, error, loadError, notice } =
    useMaintenance();
  const busy =
    pending || ["updating", "restarting"].includes(status?.task?.state);
  const taskLabels = {
    updating: "正在更新…",
    restarting: "正在重启…",
  };
  return (
    <section
      ref={section}
      className="service-maintenance-settings"
      aria-labelledby="service-maintenance-title"
    >
      <h3 ref={heading} id="service-maintenance-title" tabIndex={-1}>
        更新与重启
      </h3>
      <div className="service-update-card">
        <div className="service-product">
          <img src={productIcon} width="40" height="40" alt="" />
          <div>
            <strong>Claudex Web</strong>
            <p className="service-product-versions">
              <span>
                当前版本 {status?.current || __CLAUDEX_WEB_BUILD__.version}
              </span>
              {status?.updateAvailable && <span>最新版本 {status.latest}</span>}
            </p>
          </div>
        </div>
        <div className="service-update-bottom">
          <div className="service-maintenance-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => serviceMaintenance.request("check")}
            >
              {pendingAction === "check" && (
                <RefreshCw size={12} className="spin" aria-hidden="true" />
              )}
              {pendingAction === "check" ? "检查中" : "检查更新"}
            </button>
            <button
              className="secondary"
              disabled={busy || !status?.managed}
              onClick={() => serviceMaintenance.request("restart")}
            >
              重启服务
            </button>
            <button
              className={`service-update-button ${status?.updateAvailable ? "primary" : "secondary"}`}
              data-current={!status?.updateAvailable}
              disabled={
                busy ||
                !status?.updateAvailable ||
                !status?.npmInstalled ||
                !status?.managed
              }
              onClick={() => serviceMaintenance.request("update")}
            >
              {status?.updateAvailable
                ? `更新至 ${status.latest}`
                : status?.latest
                  ? "无需更新"
                  : "待检查"}
            </button>
          </div>
        </div>
      </div>
      {status?.task && taskLabels[status.task.state] && (
        <p role="status">{taskLabels[status.task.state]}</p>
      )}
      {notice && (
        <p
          role={notice.state === "failed" ? "alert" : "status"}
          className={notice.state === "failed" ? "inline-error" : undefined}
        >
          {notice.message}
        </p>
      )}
      {(error || loadError || status?.error) && (
        <p className="inline-error" role="alert">
          {error || loadError || status.error}
        </p>
      )}
    </section>
  );
}
