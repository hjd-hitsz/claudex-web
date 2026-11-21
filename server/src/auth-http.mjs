import { isIP } from "node:net";

export const sessionCookieName = "__Host-claudex-web-session";
const pendingCookieName = "__Host-claudex-web-login";
const cookie = (name, value, seconds) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;

function ipAddress(value) {
  const address = value
    ?.replace(/^\[|\]$/g, "")
    .replace(/^::ffff:(?=\d+\.)/i, "");
  if (isIP(address) === 4) return address;
  if (isIP(address) === 6 && !address.includes("%"))
    return new URL(`https://[${address}]`).hostname.slice(1, -1);
}

export function isDirectLocalRequest({ socket, headers }) {
  const source = ipAddress(socket.remoteAddress);
  if (!socket.encrypted || !source || source !== ipAddress(socket.localAddress))
    return false;
  if (
    Object.keys(headers).some(
      (name) =>
        name === "forwarded" ||
        name === "via" ||
        name === "x-real-ip" ||
        name === "cf-connecting-ip" ||
        name === "true-client-ip" ||
        name.startsWith("x-forwarded-"),
    )
  )
    return false;
  const authority = /^(\[[\da-f:.]+\]|[\w.-]+)(?::(\d+))?$/i.exec(
    headers.host || "",
  );
  if (!authority || Number(authority[2] || 443) !== socket.localPort)
    return false;
  const host = authority[1].toLowerCase();
  if (socket.servername && socket.servername.toLowerCase() !== host)
    return false;
  return host === "localhost"
    ? source === "127.0.0.1" || source === "::1"
    : ipAddress(host) === source;
}

export function requestToken(request, name, fallback = name) {
  const entries = (request.headers.cookie || "")
    .split(";")
    .map((value) => value.trim());
  const key = entries.some((entry) => entry.startsWith(name + "="))
    ? name
    : fallback;
  const matches = entries.filter((entry) => entry.startsWith(key + "="));
  if (matches.length === 1) return matches[0].slice(key.length + 1);
}

export function json(response, status, body, headers = {}) {
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
export function createAuthHttpHandler({
  loginFlow,
  sessionId,
  sameOrigin,
  valid,
  describe,
  logout,
  sessionDays,
}) {
  return async function handle(request, response, route) {
    if (!route.startsWith("/api/auth/")) return false;
    const pendingToken = requestToken(request, pendingCookieName);
    const clearPending = cookie(pendingCookieName, "", 0);
    try {
      const id = sessionId(request);
      const local = isDirectLocalRequest(request);
      if (route === "/api/auth/session" && request.method === "GET") {
        const session = valid(id, undefined, local);
        json(
          response,
          200,
          session
            ? describe(session)
            : (loginFlow.pending(pendingToken) ?? {
                authenticated: false,
              }),
        );
        return true;
      }
      if (
        !["/api/auth/login", "/api/auth/totp", "/api/auth/logout"].includes(
          route,
        ) ||
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
        loginFlow.cancel(pendingToken);
        await logout(id, undefined, local);
        json(
          response,
          200,
          { authenticated: false },
          {
            "Set-Cookie": [cookie(sessionCookieName, "", 0), clearPending],
          },
        );
        return true;
      }
      const options = {
        previousId: id,
        pendingToken,
        local: local && request.headers["sec-fetch-site"] === "same-origin",
      };
      const address = request.socket.remoteAddress;
      const result =
        route === "/api/auth/login"
          ? await loginFlow.login(() => credentials(request), address, options)
          : await loginFlow.verify(
              await credentials(request),
              address,
              options,
            );
      json(response, 200, result.session, {
        "Set-Cookie": result.pendingToken
          ? cookie(
              pendingCookieName,
              result.pendingToken,
              loginFlow.challengeSeconds,
            )
          : [
              cookie(sessionCookieName, result.token, sessionDays * 86400),
              clearPending,
            ],
      });
    } catch (error) {
      request.resume();
      if (!response.headersSent && !response.destroyed) {
        const status = typeof error.cause === "number" ? error.cause : 503;
        json(
          response,
          status,
          {
            error:
              typeof error.cause === "number"
                ? error.message
                : "登录暂不可用，请稍后重试或联系管理员。",
          },
          {
            ...(status === 429 && { "Retry-After": "900" }),
            ...(status === 410 && { "Set-Cookie": clearPending }),
          },
        );
      }
    }
    return true;
  };
}
