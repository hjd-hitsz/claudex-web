import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { createLoginFlow, localSessionBinding } from "./auth-login.mjs";
import { openTotpStore, prepareAuthDirectory } from "./auth-totp.mjs";
import {
  createAuthHttpHandler,
  isDirectLocalRequest,
  json,
  requestToken,
  sessionCookieName,
} from "./auth-http.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const tokenId = (token) =>
  typeof token === "string" && /^[a-zA-Z0-9_-]{43}$/.test(token)
    ? digest(token)
    : null;
function isLoopback(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}
export async function createAuthentication(config) {
  const directory = await prepareAuthDirectory(config);
  const path = join(directory, "sessions.json");
  const username = userInfo().username;
  let entries = [];
  try {
    entries = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const totp = await openTotpStore(directory);
  const currentBinding = totp.state().binding;
  const allowed = (session, binding) =>
    session &&
    (session.binding === localSessionBinding ||
      (binding && session.binding === binding)) &&
    session.expiresAt > Date.now();
  const sessions = new Map(
    entries.filter(
      ([, session]) =>
        session.username === username && allowed(session, currentBinding),
    ),
  );
  const sockets = new Map();
  const responses = new Map();
  let writing = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify([...sessions]);
    const result = writing
      .catch(() => {})
      .then(async () => {
        await writeFile(path + ".tmp", snapshot, { mode: 0o600 });
        await rename(path + ".tmp", path);
      });
    writing = result;
    return result;
  };
  if (entries.length !== sessions.size) await persist();
  const secretPath = join(directory, "maintenance-token");
  let maintenanceToken;
  try {
    maintenanceToken = await readFile(secretPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    maintenanceToken = randomBytes(32).toString("hex");
    await writeFile(secretPath, maintenanceToken, { mode: 0o600, flag: "wx" });
  }
  const revoke = (id) => {
    sessions.delete(id);
    for (const socket of sockets.get(id) || [])
      socket.close(4401, "登录已失效，请重新登录");
    sockets.delete(id);
    for (const response of responses.get(id) || []) response.destroy();
    responses.delete(id);
  };
  const lookup = (id) => {
    const session = sessions.get(id);
    if (!session) return null;
    if (!allowed(session, totp.state().binding)) {
      revoke(id);
      persist().catch((error) => console.error("清理失效登录会话失败", error));
      return null;
    }
    return session;
  };
  const valid = (id, linkId, local = false) => {
    const session = lookup(id);
    if (
      session?.linkId !== linkId ||
      (session?.binding === localSessionBinding && !local)
    )
      return null;
    return session;
  };
  function trackConnection(connections, id, connection, session) {
    if (!connections.has(id)) connections.set(id, new Set());
    const tracked = connections.get(id);
    tracked.add(connection);
    let timer;
    const expire = () => {
      if (!lookup(id)) return;
      timer = setTimeout(
        expire,
        Math.min(session.expiresAt - Date.now(), 2147483647),
      );
      timer.unref();
    };
    const untrack = () => {
      connection.removeListener("close", untrack);
      clearTimeout(timer);
      tracked.delete(connection);
      if (!tracked.size && connections.get(id) === tracked)
        connections.delete(id);
    };
    connection.once("close", untrack);
    expire();
    return untrack;
  }
  const sessionId = (request) =>
    tokenId(
      requestToken(request, sessionCookieName, "__Host-codex-web-session"),
    );
  const sameOrigin = (request) => {
    const origin = request.headers.origin;
    return (
      request.headers["sec-fetch-site"] !== "cross-site" &&
      origin === `https://${request.headers.host}`
    );
  };
  const sessionCheck = setInterval(() => {
    if (!sessions.size) return;
    try {
      const { binding } = totp.state();
      const expired = [...sessions].filter(
        ([, session]) => !allowed(session, binding),
      );
      if (!expired.length) return;
      for (const [id] of expired) revoke(id);
      persist().catch((error) => console.error("清理失效登录会话失败", error));
    } catch (error) {
      console.error("检查登录会话失败", error);
    }
  }, 1000);
  sessionCheck.unref();
  const describe = ({ username, expiresAt, binding }) => ({
    authenticated: true,
    username,
    expiresAt,
    ...(binding === localSessionBinding
      ? { kind: "local", totpStatus: totp.state().status }
      : {
          totpStatus: binding.startsWith("totp:") ? "enabled" : "disabled",
        }),
  });
  async function issueSession({ previousId, linkId, signal, binding, local }) {
    const current =
      binding === localSessionBinding
        ? local && !linkId
        : binding && totp.state().binding === binding;
    if (!current)
      throw new Error("登录设置已变更，请重新登录。", { cause: 410 });
    for (const [key, session] of sessions)
      if (session.expiresAt <= Date.now()) revoke(key);
    if (sessions.size >= 64) revoke(sessions.keys().next().value);
    if (valid(previousId, linkId, local)) revoke(previousId);
    const token = randomBytes(32).toString("base64url");
    const id = digest(token);
    const session = {
      username,
      expiresAt: Date.now() + config.sessionDays * 86400000,
      binding,
    };
    sessions.set(id, linkId ? { ...session, linkId } : session);
    try {
      await persist();
      if (signal?.aborted) {
        revoke(id);
        await persist();
        signal.throwIfAborted();
      }
      if (!lookup(id))
        throw new Error("登录设置已变更，请重新登录。", { cause: 410 });
    } catch (error) {
      revoke(id);
      throw error;
    }
    return { id, token, session: describe(session) };
  }
  async function logout(id, linkId, local) {
    if (!valid(id, linkId, local)) return;
    revoke(id);
    await persist();
  }
  const loginFlow = createLoginFlow({ config, username, totp, issueSession });
  return {
    close() {
      clearInterval(sessionCheck);
      totp.close();
    },
    sameOrigin,
    isDirectLocalRequest,
    describe,
    valid,
    sessionId,
    authorize(request, response) {
      const id = sessionId(request);
      const session = valid(id, undefined, isDirectLocalRequest(request));
      if (!session) {
        json(response, 401, { error: "请先登录。" });
        return false;
      }
      if (
        ((request.headers.origin ||
          !["GET", "HEAD"].includes(request.method)) &&
          !sameOrigin(request)) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        json(response, 403, { error: "请求来源不匹配。" });
        return false;
      }
      trackConnection(responses, id, response, session);
      return true;
    },
    maintenance(request) {
      const supplied = Buffer.from(request.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${maintenanceToken}`);
      return (
        !request.headers.origin &&
        isLoopback(request.socket.remoteAddress) &&
        supplied.length === expected.length &&
        timingSafeEqual(supplied, expected)
      );
    },
    attach(socket, id, linkId, local) {
      const session = valid(id, linkId, local);
      if (!session) {
        socket.close(4401, "登录已失效，请重新登录");
        return;
      }
      socket.authSessionId = id;
      socket.authLocal = local;
      return trackConnection(sockets, id, socket, session);
    },
    loginPeer(linkId, input, options) {
      return loginFlow.login(() => input, `p2p:${linkId}`, {
        ...options,
        linkId,
      });
    },
    verifyPeer(linkId, input, options) {
      return loginFlow.verify(input, `p2p:${linkId}`, { ...options, linkId });
    },
    cancelPeer: loginFlow.cancel,
    resumePeer(linkId, token) {
      const id = tokenId(token);
      const session = valid(id, linkId);
      if (!session) return { session: { authenticated: false } };
      return { id, session: describe(session) };
    },
    logoutPeer: (linkId, id) => logout(id, linkId),
    async revokeLink(linkId) {
      const ids = [...sessions].filter(
        ([, session]) => session.linkId === linkId,
      );
      if (!ids.length) return;
      for (const [id] of ids) revoke(id);
      await persist();
    },
    handle: createAuthHttpHandler({
      loginFlow,
      sessionId,
      sameOrigin,
      valid,
      describe,
      logout,
      sessionDays: config.sessionDays,
    }),
  };
}
