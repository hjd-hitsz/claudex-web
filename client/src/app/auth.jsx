import React, { useEffect, useState } from "react";
import { LockKeyhole, LogOut, LoaderCircle } from "lucide-react";
import {
  useStore,
  checkSession,
  login,
  verifyTotp,
  logout,
  applySession,
  startNotifications,
  useStoreSelector,
} from "../store.js";
import claudexWebIcon from "../assets/claudex-web.svg";
import { CertificateHelp } from "./certificate-help.jsx";
import { TotpSettings, TotpSetupSteps } from "./totp-help.jsx";
import { isP2pPage, p2pDownloadFrame } from "../infrastructure/p2p-access.js";

export function AuthenticationGate({ children }) {
  const { auth, authError, theme } = useStore();
  const p2p = isP2pPage();
  const verifying = auth?.requiresTotp === true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => startNotifications(), []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") checkSession();
    };
    refresh();
    const interval = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    if (p2p) {
      window.addEventListener("hashchange", refresh);
      window.addEventListener("online", refresh);
    }
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("hashchange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [p2p]);
  useEffect(() => {
    if (
      (!verifying && (p2p || !auth?.authenticated)) ||
      !Number.isFinite(auth?.expiresAt)
    )
      return;
    let timer;
    const expire = () => {
      const remaining = auth.expiresAt - Date.now();
      if (remaining <= 0) {
        applySession({ authenticated: false });
        if (verifying) setError("本次验证已超时，请重新输入系统密码。");
        return;
      }
      timer = setTimeout(expire, Math.min(remaining, 2147483647));
    };
    expire();
    return () => clearTimeout(timer);
  }, [auth, p2p, verifying]);
  if (auth?.authenticated)
    return p2p ? (
      <>
        {children}
        <iframe name={p2pDownloadFrame} title="P2P 文件下载" hidden />
      </>
    ) : (
      children
    );
  if (p2p && auth === null) {
    return (
      <main className="login-page">
        <section className="login-card" aria-labelledby="p2p-join-title">
          <div className="login-brand">
            <img src={claudexWebIcon} width="40" height="40" alt="" />
            <span>Claudex Web</span>
          </div>
          <h1 id="p2p-join-title">
            {authError ? "P2P 远程连接" : "正在与电脑建立 P2P 直连"}
          </h1>
          {authError ? (
            <>
              <p role="alert" className="inline-error">
                {authError}
              </p>
              <button className="primary" onClick={checkSession}>
                重试连接
              </button>
            </>
          ) : (
            <LoaderCircle className="spin" aria-label="正在连接" />
          )}
        </section>
      </main>
    );
  }
  const waiting = auth === null;
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    try {
      if (verifying)
        await verifyTotp(fields.get("code"), fields.get("name") ?? undefined);
      else await login(fields.get("username"), fields.get("password"));
    } catch (failure) {
      const input = form.elements.namedItem(verifying ? "code" : "password");
      input.value = "";
      input.focus();
      setError(failure.message);
      if (verifying && [401, 409].includes(failure.status)) void checkSession();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section
        className={"login-card" + (verifying ? " login-card--totp" : "")}
        aria-labelledby="login-title"
      >
        <div className="login-brand">
          <img src={claudexWebIcon} width="40" height="40" alt="" />
          <span>Claudex Web</span>
        </div>
        <h1 id="login-title">
          {verifying
            ? "双重验证"
            : p2p
              ? "登录远程工作空间"
              : waiting
                ? "正在检查登录状态"
                : "登录你的工作空间"}
        </h1>
        {waiting ? (
          <>
            {authError ? (
              <>
                <p role="alert" className="inline-error">
                  {authError}
                </p>
                <button className="primary" onClick={checkSession}>
                  重新检查
                </button>
              </>
            ) : (
              <LoaderCircle className="spin" aria-label="正在检查" />
            )}
          </>
        ) : verifying ? (
          <>
            <form
              id="totp-form"
              action={p2p ? "/p2p" : "/api/auth/totp"}
              method="post"
              onSubmit={submit}
            >
              {auth.totpName && (
                <label className="field-label">
                  验证器名称
                  <input
                    className="field-input"
                    name="name"
                    placeholder={
                      auth.totpName === "optional"
                        ? "默认验证器可留空"
                        : undefined
                    }
                    autoFocus={auth.totpName === "required"}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required={auth.totpName === "required"}
                    maxLength={64}
                    readOnly={busy}
                  />
                </label>
              )}
              <input
                className="field-input"
                name="code"
                type="text"
                aria-label="六位动态码"
                placeholder="输入六位动态码"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus={auth.totpName !== "required"}
                required
                pattern="[0-9]{6}"
                maxLength={6}
                readOnly={busy}
              />
              {(error || authError) && (
                <p className="inline-error" role="alert">
                  {error || authError}
                </p>
              )}
              <button
                type="submit"
                className="primary login-submit"
                disabled={busy}
              >
                {busy ? "正在验证…" : "验证并登录"}
              </button>
            </form>
            <section
              className="totp-help totp-first-use"
              aria-labelledby="totp-setup-title"
            >
              <h2 id="totp-setup-title">
                {auth.totpStatus === "enabled"
                  ? "如何绑定验证器"
                  : "首次使用请绑定验证器"}
              </h2>
              <TotpSetupSteps
                duringLogin
                named={auth.totpName || auth.totpStatus === "enabled"}
              />
            </section>
          </>
        ) : (
          <>
            <form
              id="login-form"
              action={p2p ? "/p2p" : "/api/auth/login"}
              method="post"
              autoComplete="on"
              onSubmit={submit}
            >
              <label className="field-label">
                用户名
                <input
                  id="login-username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  required
                  maxLength={256}
                  autoCapitalize="none"
                  spellCheck={false}
                  readOnly={busy}
                />
              </label>
              <label className="field-label">
                密码
                <input
                  id="login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                  readOnly={busy}
                />
              </label>
              {(error || authError) && (
                <p className="inline-error" role="alert">
                  {error || authError}
                </p>
              )}
              <button
                type="submit"
                className="primary login-submit"
                disabled={busy}
              >
                {busy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <LockKeyhole size={17} />
                )}
                {busy ? "正在验证…" : "登录"}
              </button>
            </form>
          </>
        )}
        {!p2p && !verifying && <CertificateHelp />}
      </section>
    </main>
  );
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const auth = useStoreSelector((state) => state.auth);
  const p2p = auth?.kind === "p2p";
  const local = auth?.kind === "local";
  useEffect(() => {
    void checkSession();
  }, []);
  return (
    <div className="login-settings">
      <p>{`已登录：${auth?.username}${p2p ? " · P2P 直连" : local ? " · 本机直连" : ""}`}</p>
      <button
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await logout();
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <LogOut size={16} />
        {busy ? "正在退出…" : "退出登录"}
      </button>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {auth?.totpStatus && <TotpSettings status={auth.totpStatus} />}
    </div>
  );
}
