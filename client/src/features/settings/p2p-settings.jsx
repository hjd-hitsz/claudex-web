import React, { useEffect, useRef, useState } from "react";
import { requestP2pSettings } from "../../infrastructure/p2p-settings.js";

const stateLabels = {
  disabled: "已关闭",
  connecting: "正在连接入口…",
  online: "入口在线",
  error: "入口连接失败",
};

function P2pLinkRow({ link, busy, confirming, onConfirm, onCancel, onRevoke }) {
  const [copyState, setCopyState] = useState("");
  const fallback = useRef(null);
  const revoke = useRef(null);
  useEffect(() => {
    if (copyState === "manual") {
      fallback.current?.focus();
      fallback.current?.select();
    }
    if (copyState === "copied") {
      const timer = setTimeout(() => setCopyState(""), 2400);
      return () => clearTimeout(timer);
    }
  }, [copyState]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
    }
  }
  return (
    <li>
      <div className="p2p-settings-row">
        <span className="p2p-link-name">{link.label || "远程连接"}</span>
        <div className="p2p-link-actions">
          {confirming && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                onCancel();
                revoke.current?.focus();
              }}
            >
              取消
            </button>
          )}
          {!confirming && link.url && (
            <button
              type="button"
              className="secondary p2p-copy-button"
              onClick={copy}
            >
              <span aria-live="polite">
                {copyState === "copied" ? "已复制" : "复制链接"}
              </span>
            </button>
          )}
          <button
            type="button"
            ref={revoke}
            className="secondary p2p-revoke-button"
            disabled={busy}
            aria-label={`${confirming ? "确认撤销" : "撤销"} ${link.label || "远程连接"}`}
            onClick={confirming ? onRevoke : onConfirm}
          >
            {confirming ? "确认撤销" : "撤销"}
          </button>
        </div>
      </div>
      {confirming && (
        <p className="section-description" role="status">
          撤销后，所有使用此链接的设备将断开连接。
        </p>
      )}
      {copyState === "manual" && !confirming && (
        <input
          ref={fallback}
          className="p2p-link-address"
          value={link.url}
          readOnly
          aria-label="选择并复制授权链接"
        />
      )}
    </li>
  );
}

export function P2pSettings() {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [retry, setRetry] = useState(0);
  const mutation = useRef(null);
  const toggle = useRef(null);

  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const latest = await requestP2pSettings(null, null, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(latest);
        setLoadError("");
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 4000);
      }
    }
    void load();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [busy, retry]);
  useEffect(() => () => mutation.current?.abort(), []);

  async function change(action, data = {}) {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setOperationError("");
    try {
      const latest = await requestP2pSettings(action, data, controller.signal);
      if (controller.signal.aborted) return;
      setStatus(latest);
      setLoadError("");
      if (action === "create")
        setLabel((value) => (value.trim() === data.label ? "" : value));
      if (action === "revoke") {
        setConfirmId(null);
        requestAnimationFrame(() => toggle.current?.focus());
      }
    } catch (error) {
      if (!controller.signal.aborted) setOperationError(error.message);
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const canCreate = status?.enabled && status.state === "online";
  return (
    <div className="p2p-settings">
      <div className="p2p-settings-row">
        <label className="p2p-settings-toggle">
          <input
            ref={toggle}
            type="checkbox"
            checked={Boolean(status?.enabled)}
            disabled={busy || !status || Boolean(loadError)}
            onChange={(event) =>
              void change(event.target.checked ? "enable" : "disable")
            }
          />
          P2P 远程访问
        </label>
        <span
          className="backend-connection"
          data-ready={status?.state === "online" && !loadError}
          role="status"
        >
          {loadError
            ? "状态暂不可用"
            : (stateLabels[status?.state] ?? "正在读取…")}
        </span>
      </div>
      {(operationError || loadError || status?.error) && (
        <div className="p2p-settings-row p2p-settings-feedback">
          <p className="inline-error" role="alert">
            {operationError || loadError || status.error}
          </p>
          {loadError && (
            <button
              type="button"
              className="secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              重试
            </button>
          )}
        </div>
      )}
      {canCreate && (
        <form
          className="p2p-settings-row p2p-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void change("create", { label: label.trim() });
          }}
        >
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="设备名称（可选）"
            aria-label="设备名称"
            autoComplete="off"
            maxLength={80}
          />
          <button
            type="submit"
            className="secondary"
            disabled={busy || Boolean(loadError)}
          >
            生成链接
          </button>
        </form>
      )}
      {status?.links?.length > 0 && (
        <ul className="p2p-link-list" aria-label="已授权链接">
          {status.links.map((link) => (
            <P2pLinkRow
              key={link.id}
              link={link}
              confirming={confirmId === link.id}
              busy={busy || Boolean(loadError)}
              onConfirm={() => setConfirmId(link.id)}
              onCancel={() => setConfirmId(null)}
              onRevoke={() => void change("revoke", { id: link.id })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
