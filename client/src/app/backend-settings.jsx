import { cliUpdateAvailable } from "../domain/cli-installation.js";
import React, { useEffect, useRef, useState } from "react";
import { useStore, saveBackend, rpc } from "../store.js";
import { CodexModelSettings } from "./codex-model-settings.jsx";
import { ProviderSettings } from "./provider-settings.jsx";
import { ProxySettings } from "./proxy-settings.jsx";

export function BackendSettings() {
  const s = useStore();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const previousInstallations = useRef(new Map());
  const installationAttempts = useRef(new Set());
  useEffect(() => {
    for (const backend of s.backends) {
      const cli = backend.installation || {};
      const previous = previousInstallations.current.get(backend.id);
      if (
        previous &&
        !cli.installing &&
        cli.installError &&
        (previous.installing ||
          previous.error !== cli.installError ||
          installationAttempts.current.has(backend.id))
      ) {
        setNotice({ id: backend.id, message: cli.installError });
      }
      if (!cli.installing) installationAttempts.current.delete(backend.id);
      previousInstallations.current.set(backend.id, {
        installing: cli.installing,
        error: cli.installError,
      });
    }
  }, [s.backends]);
  useEffect(() => {
    if (!error && !notice) return;
    const timer = setTimeout(() => {
      setError("");
      setNotice(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [error, notice]);
  async function action(run, installationId) {
    setBusy(true);
    setError("");
    setNotice(null);
    if (installationId) installationAttempts.current.add(installationId);
    try {
      await run();
    } catch (e) {
      installationAttempts.current.delete(installationId);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="backend-settings"
      aria-labelledby="backend-settings-title"
    >
      <h3 id="backend-settings-title">模型与服务配置</h3>
      {s.backends.map((backend) => {
        const cli = backend.installation || {};
        const working = busy || cli.installing;
        const updateAvailable = cliUpdateAvailable(
          cli.currentVersion,
          cli.latestVersion,
        );
        const connected =
          cli.installed !== false && backend.enabled && backend.ready;
        const diagnostic = cli.installErrorDetails || cli.errorDetails;
        const connection =
          cli.installed === false
            ? "未安装"
            : !backend.enabled
              ? "已停用"
              : backend.ready
                ? "已连接"
                : "连接失败";
        return (
          <section className="backend-card" key={backend.id}>
            <div className="backend-heading">
              <input
                type="checkbox"
                aria-label={"启用 " + backend.name}
                checked={backend.enabled}
                disabled={working}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  action(() =>
                    saveBackend({
                      id: backend.id,
                      type: backend.type,
                      enabled,
                    }),
                  );
                }}
              />
              <strong>{backend.name}</strong>
              {cli.currentVersion && (
                <span
                  className="backend-version"
                  title={`当前版本 ${cli.currentVersion}`}
                >
                  {cli.currentVersion}
                </span>
              )}
              <span
                className="backend-connection"
                data-ready={connected}
                role="status"
                aria-label={connection}
                title={connection}
              >
                {connected ? null : connection}
              </span>
              <button
                data-update={updateAvailable}
                data-current={cli.installed === true && !updateAvailable}
                title={
                  cli.latestVersion
                    ? `最新版本 ${cli.latestVersion}`
                    : undefined
                }
                disabled={
                  working || (cli.installed !== false && !updateAvailable)
                }
                onClick={() =>
                  action(async () => {
                    await rpc("lan/backends/install", { id: backend.id });
                  }, backend.id)
                }
              >
                {cli.installing
                  ? "正在安装…"
                  : cli.installed === false
                    ? "一键安装"
                    : updateAvailable
                      ? `更新至 ${cli.latestVersion}`
                      : cli.latestVersion && cli.currentVersion
                        ? "无需更新"
                        : "待检查"}
              </button>
            </div>
            {notice?.id === backend.id && (
              <p className="inline-error" role="alert">
                {notice.message}
              </p>
            )}
            {(cli.latestError || cli.error || backend.error) && (
              <p role="status">
                {cli.latestError || cli.error || backend.error}
              </p>
            )}
            {diagnostic && (
              <details className="cli-error-details">
                <summary>错误详情</summary>
                <pre>{diagnostic}</pre>
              </details>
            )}
            {backend.type === "codex" && (
              <CodexModelSettings backend={backend} />
            )}
            {backend.type === "claude" && (
              <>
                <ProxySettings backend={backend} disabled={working} />
                <ProviderSettings backend={backend} />
              </>
            )}
          </section>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
