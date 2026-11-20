import { migrateWebDirectory } from "./web-config-migration.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { authenticateSystemUser } from "./system-auth.mjs";

const cookieName = "__Host-claudex-web-session";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tokenId = (token) =>
  typeof token === "string" && /^[a-zA-Z0-9_-]{43}$/.test(token)
    ? digest(token)
    : null;
const cookie = (value, seconds) =>
  `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
function isLoopback(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}
function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}
async function credentials(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""))
    throw new Error("请使用 JSON 提交登录信息。", { cause: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8192) throw new Error("登录信息过长。", { cause: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("登录信息格式错误。", { cause: 400 });
  }
}
export async function createAuthentication(config) {
  await migrateWebDirectory(config, "auth", [
    "sessions.json",
    "maintenance-token",
  ]);
  const directory = join(config.configDir, "auth");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "sessions.json");
  const username = userInfo().username;
  let entries = [];
  try {
    entries = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const sessions = new Map(
    entries.filter(
      ([, s]) => s.username === username && s.expiresAt > Date.now(),
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
    if (!session || session.expiresAt <= Date.now()) {
      revoke(id);
      return null;
    }
    return session;
  };
  const valid = (id, linkId) => {
    const session = lookup(id);
    return session?.linkId === linkId ? session : null;
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
  const sessionId = (request) => {
    const entries = (request.headers.cookie || "")
      .split(";")
      .map((s) => s.trim());
    const name = entries.some((s) => s.startsWith(cookieName + "="))
      ? cookieName
      : "__Host-codex-web-session";
    const tokens = entries.filter((s) => s.startsWith(name + "="));
    if (tokens.length !== 1) return null;
    return tokenId(tokens[0].slice(name.length + 1));
  };
  const sameOrigin = (request) => {
    const origin = request.headers.origin;
    return (
      request.headers["sec-fetch-site"] !== "cross-site" &&
      origin === `https://${request.headers.host}`
    );
  };
  const attempts = new Map();
  let active = 0,
    globalAttempts = [];
  function limited(address) {
    const now = Date.now();
    for (const [ip, record] of attempts)
      if (record.until <= now) attempts.delete(ip);
    globalAttempts = globalAttempts.filter((time) => time > now - 60000);
    const record = attempts.get(address) || {
      count: 0,
      until: now + 15 * 60000,
    };
    if (
      active >= 2 ||
      record.count >= 10 ||
      globalAttempts.length >= 30 ||
      attempts.size >= 1024
    )
      return true;
    record.count++;
    attempts.set(address, record);
    globalAttempts.push(now);
    return false;
  }
  async function login(
    readInput,
    attemptKey,
    { previousId, linkId, signal } = {},
  ) {
    if (limited(attemptKey))
      throw new Error("登录尝试过于频繁，请稍后重试。", { cause: 429 });
    active++;
    try {
      const { username: submitted, password } = (await readInput()) || {};
      if (
        typeof submitted !== "string" ||
        typeof password !== "string" ||
        !submitted ||
        !password ||
        submitted.length > 256 ||
        password.length > 1024 ||
        /\0/.test(submitted + password)
      )
        throw new Error("请输入有效的系统用户名和密码。", { cause: 400 });
      if (
        submitted !== username ||
        !(await authenticateSystemUser(submitted, password, config))
      )
        throw new Error(
          "用户名或密码错误，或系统账户不可用。请使用运行服务的系统账户。",
          { cause: 401 },
        );
      signal?.throwIfAborted();
      for (const [key, session] of sessions)
        if (session.expiresAt <= Date.now()) revoke(key);
      if (sessions.size >= 64) revoke(sessions.keys().next().value);
      if (valid(previousId, linkId)) revoke(previousId);
      const token = randomBytes(32).toString("base64url");
      const id = digest(token);
      const session = {
        username,
        expiresAt: Date.now() + config.sessionDays * 86400000,
      };
      sessions.set(id, linkId ? { ...session, linkId } : session);
      try {
        await persist();
        if (signal?.aborted) {
          revoke(id);
          await persist();
          signal.throwIfAborted();
        }
      } catch (error) {
        revoke(id);
        throw error;
      }
      return { id, token, session: { authenticated: true, ...session } };
    } finally {
      active--;
    }
  }
  return {
    sameOrigin,
    valid,
    sessionId,
    authorize(request, response) {
      const id = sessionId(request);
      const session = valid(id);
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
    attach(socket, id, linkId) {
      const session = valid(id, linkId);
      if (!session) {
        socket.close(4401, "登录已失效，请重新登录");
        return;
      }
      socket.authSessionId = id;
      return trackConnection(sockets, id, socket, session);
    },
    async loginPeer(linkId, input, signal) {
      return login(() => input, `p2p:${linkId}`, { linkId, signal });
    },
    resumePeer(linkId, token) {
      const id = tokenId(token);
      const session = valid(id, linkId);
      if (!session) return { session: { authenticated: false } };
      const { username, expiresAt } = session;
      return { id, session: { authenticated: true, username, expiresAt } };
    },
    async logoutPeer(linkId, id) {
      if (!valid(id, linkId)) return;
      revoke(id);
      await persist();
    },
    async revokeLink(linkId) {
      const ids = [...sessions].filter(
        ([, session]) => session.linkId === linkId,
      );
      if (!ids.length) return;
      for (const [id] of ids) revoke(id);
      await persist();
    },
    async handle(request, response, route) {
      if (!route.startsWith("/api/auth/")) return false;
      try {
        const id = sessionId(request);
        if (route === "/api/auth/session" && request.method === "GET") {
          const session = valid(id);
          json(
            response,
            200,
            session
              ? { authenticated: true, ...session }
              : { authenticated: false },
          );
          return true;
        }
        if (
          !["/api/auth/login", "/api/auth/logout"].includes(route) ||
          request.method !== "POST"
        ) {
          json(response, 405, { error: "不支持此登录操作。" });
          return true;
        }
        if (
          !sameOrigin(request) ||
          request.headers["x-claudex-web-request"] !== "1"
        ) {
          json(response, 403, { error: "请求来源不匹配，请重新打开本站。" });
          return true;
        }
        if (route === "/api/auth/logout") {
          if (valid(id)) revoke(id);
          await persist();
          json(
            response,
            200,
            { authenticated: false },
            { "Set-Cookie": cookie("", 0) },
          );
          return true;
        }
        const { token, session } = await login(
          () => credentials(request),
          request.socket.remoteAddress,
          { previousId: id },
        );
        json(response, 200, session, {
          "Set-Cookie": cookie(token, config.sessionDays * 86400),
        });
      } catch (error) {
        request.resume();
        if (!response.headersSent && !response.destroyed)
          json(
            response,
            typeof error.cause === "number" ? error.cause : 503,
            {
              error:
                typeof error.cause === "number"
                  ? error.message
                  : "登录暂不可用，请稍后重试或联系管理员。",
            },
            error.cause === 429 ? { "Retry-After": "900" } : {},
          );
      }
      return true;
    },
  };
}
