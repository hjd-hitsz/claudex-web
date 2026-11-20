import { completePasswordLogin } from "../infrastructure/password-manager.js";
import { forgetP2pToken, readP2pToken } from "../infrastructure/p2p-access.js";

export function createSession({ get, set, transport, connection, p2p }) {
  let authRevision = 0;
  let authMutating = false;
  let p2pToken = "";
  function applySession(session) {
    authRevision++;
    if (session.authenticated && session.expiresAt <= Date.now())
      session = { authenticated: false };
    set({ auth: session, authError: "" });
    if (session.authenticated) {
      if (!transport.connection || transport.connection.readyState > 1)
        transport.connect();
    } else {
      connection.reset();
      set({
        connected: false,
        usageLoading: false,
        modal: null,
        terminalOpen: false,
      });
      transport.disconnect(
        new Error("登录已结束；已提交的任务会在电脑上继续。"),
      );
    }
  }
  async function authRequest(path, input) {
    const response = await fetch(`/api/auth/${path}`, {
      method: input ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
      ...(input
        ? {
            headers: {
              "Content-Type": "application/json",
              "X-Claudex-Web-Request": "1",
            },
            body: JSON.stringify(input),
          }
        : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "登录请求失败，请重试。");
    return result;
  }
  async function checkSession() {
    if (p2p) {
      const token = readP2pToken();
      if (p2pToken !== token) {
        p2pToken = token;
        if (transport.connection) applySession({ authenticated: false });
      }
      if (!token) {
        if (!get().authError)
          set({ authError: "请打开包含授权信息的完整 P2P 链接。" });
      } else if (!transport.connection || transport.connection.readyState > 1) {
        set({ authError: "" });
        transport.connect({ beforeAuthentication: true });
      }
      return;
    }
    if (authMutating) return;
    const revision = ++authRevision;
    try {
      const session = await authRequest("session");
      if (revision === authRevision) applySession(session);
    } catch {
      if (revision === authRevision)
        set({ authError: "暂时无法检查登录状态，请检查连接后重试。" });
    }
  }
  async function login(username, password) {
    const revision = ++authRevision;
    authMutating = true;
    try {
      const session = await authRequest("login", { username, password });
      if (revision === authRevision) {
        if (session.authenticated && session.expiresAt > Date.now())
          completePasswordLogin(username, password);
        applySession(session);
      }
    } finally {
      authMutating = false;
    }
  }
  async function logout() {
    if (p2p) {
      forgetP2pToken();
      p2pToken = "";
      applySession({ authenticated: false });
      set({ authError: "已断开，请通过 P2P 链接重新连接。" });
      return;
    }
    const revision = ++authRevision;
    authMutating = true;
    try {
      const session = await authRequest("logout", {});
      if (revision === authRevision) applySession(session);
    } finally {
      authMutating = false;
    }
  }
  return {
    applySession,
    checkSession,
    login,
    logout,
    get p2pToken() {
      return p2pToken;
    },
    p2pConnected() {
      applySession({ authenticated: true, kind: "p2p", username: "P2P 链接" });
    },
    p2pRejected({ code, reason }) {
      if (code === 4401) {
        forgetP2pToken();
        p2pToken = "";
        applySession({ authenticated: false });
      }
      set({ authError: reason });
    },
  };
}
