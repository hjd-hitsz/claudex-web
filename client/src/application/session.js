import { completePasswordLogin } from "../infrastructure/password-manager.js";
import { RpcConnectionError } from "../infrastructure/rpc-client.js";
import {
  forgetP2pToken,
  openP2pLoginStorage,
  readP2pToken,
} from "../infrastructure/p2p-access.js";

export function createSession({
  get,
  set,
  transport,
  connection,
  p2p,
  resetFeedback,
}) {
  let authRevision = 0;
  let authMutating = false;
  let p2pToken = "";
  let p2pLogin = "";
  let p2pLoginStorage;
  let p2pCheck;
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
      resetFeedback();
      set({
        connected: false,
        usageLoading: false,
        modal: null,
        terminalOpen: false,
      });
      if (!p2p)
        transport.disconnect(
          new RpcConnectionError("登录已结束，未收到请求结果。", true),
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
    if (!response.ok)
      throw Object.assign(new Error(result.error || "登录请求失败，请重试。"), {
        status: response.status,
      });
    return result;
  }
  async function p2pConnected(statusOnly = false) {
    const socket = transport.connection;
    if (socket === p2pCheck) return;
    p2pCheck = socket;
    const revision = authRevision;
    try {
      if (statusOnly) {
        const { session } = await socket.requestAuth("status");
        if (transport.connection === socket && authRevision === revision)
          applySession({ ...session, kind: "p2p" });
        return;
      }
      set({ p2pStage: "session", authError: "" });
      const storage = p2pLoginStorage ?? (await openP2pLoginStorage(p2pToken));
      if (transport.connection !== socket || socket.readyState !== 1) return;
      p2pLoginStorage = storage;
      const token = p2pLogin || storage.read();
      const { session } = await socket.requestAuth("resume", { token });
      if (transport.connection !== socket) return;
      if (session.authenticated) {
        p2pLogin = token;
        storage.save(token, session.expiresAt, true);
      } else {
        if (token) storage.clear(token);
        p2pLogin = "";
      }
      applySession({ ...session, kind: "p2p" });
    } catch (error) {
      if (
        !statusOnly &&
        transport.connection === socket &&
        socket.readyState === 1
      ) {
        applySession({ authenticated: false });
        set({ auth: null, authError: error.message });
      }
    } finally {
      if (p2pCheck === socket) p2pCheck = undefined;
    }
  }
  async function checkSession() {
    if (authMutating) return;
    if (p2p) {
      const token = readP2pToken();
      if (p2pToken !== token) {
        p2pToken = token;
        p2pLogin = "";
        p2pLoginStorage = undefined;
        transport.disconnect(new Error("P2P 链接已更新。"));
        applySession({ authenticated: false });
        set({ auth: null });
      }
      if (!token) {
        if (!get().authError)
          set({ authError: "请打开包含授权信息的完整 P2P 链接。" });
      } else if (!transport.connection || transport.connection.readyState > 1) {
        set({
          authError: "",
          p2pStage: "opening",
          ...(!get().auth?.authenticated && { auth: null }),
        });
        transport.connect({ beforeAuthentication: true });
      } else if (transport.connection.readyState === 1 && get().auth === null) {
        await p2pConnected();
      } else if (
        transport.connection.readyState === 1 &&
        (get().auth?.authenticated || get().auth?.requiresTotp)
      ) {
        await p2pConnected(true);
      }
      return;
    }
    const revision = ++authRevision;
    try {
      const session = await authRequest("session");
      if (revision === authRevision) applySession(session);
    } catch {
      if (revision === authRevision)
        set({ authError: "暂时无法检查登录状态，请检查连接后重试。" });
    }
  }
  async function advanceLogin(action, input) {
    const revision = ++authRevision;
    authMutating = true;
    try {
      const socket = transport.connection;
      if (p2p && socket?.readyState !== 1)
        throw new Error("P2P 连接尚未就绪，请稍后重试。");
      const { session, token } = p2p
        ? await socket.requestAuth(action, input)
        : { session: await authRequest(action, input) };
      if (revision === authRevision) {
        if (p2p && (socket !== transport.connection || socket.readyState !== 1))
          return;
        if (p2p && token && session.authenticated) {
          p2pLogin = token;
          p2pLoginStorage.save(token, session.expiresAt);
        }
        if (
          action === "login" &&
          (session.requiresTotp || session.authenticated)
        )
          completePasswordLogin(input.username, input.password);
        applySession(p2p ? { ...session, kind: "p2p" } : session);
      }
    } catch (error) {
      if (
        action === "totp" &&
        error.status === 410 &&
        revision === authRevision
      )
        applySession({ authenticated: false, ...(p2p && { kind: "p2p" }) });
      throw error;
    } finally {
      authMutating = false;
    }
  }
  async function logout() {
    const revision = ++authRevision;
    authMutating = true;
    try {
      if (p2p) {
        const socket = transport.connection;
        if (socket?.readyState !== 1)
          throw new Error("P2P 连接尚未恢复，请稍后重试。");
        await socket.requestAuth("logout");
        if (transport.connection !== socket) return;
        if (p2pLogin) p2pLoginStorage.clear(p2pLogin);
        p2pLogin = "";
        applySession({ authenticated: false, kind: "p2p" });
        return;
      }
      const session = await authRequest("logout", {});
      if (revision === authRevision) applySession(session);
    } finally {
      authMutating = false;
    }
  }
  return {
    applySession,
    checkSession,
    login: (username, password) =>
      advanceLogin("login", { username, password }),
    verifyTotp: (code, name) => advanceLogin("totp", { code, name }),
    logout,
    get p2pToken() {
      return p2pToken;
    },
    p2pConnected,
    p2pProgress: (stage) => set({ p2pStage: stage }),
    p2pRejected({ code, reason }) {
      if (code === 4401) {
        const link = p2pToken;
        if (p2pLoginStorage) p2pLoginStorage.clear();
        else
          void openP2pLoginStorage(link)
            .then((storage) => storage.clear())
            .catch(() => {});
        forgetP2pToken();
        p2pToken = "";
        p2pLogin = "";
        p2pLoginStorage = undefined;
        applySession({ authenticated: false });
      }
      set({ auth: null, authError: reason });
    },
  };
}
