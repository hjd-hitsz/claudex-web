import { once } from "node:events";
import { createServer } from "node:http";
import { createStaticHandler } from "../http/static.mjs";

export function fail(message, status) {
  return new Error(message, { cause: status });
}

function json(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readObject(request, limit) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""))
    throw fail("请使用 JSON 提交请求", 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) throw fail("请求内容过长", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
  } catch {
    // JSON 解析失败与请求形状错误使用同一响应。
  }
  throw fail("请求内容格式错误", 400);
}

const actions = new Map([
  ["/api/p2p", "status"],
  ["/api/p2p/enable", "enable"],
  ["/api/p2p/disable", "disable"],
  ["/api/p2p/create", "create"],
  ["/api/p2p/revoke", "revoke"],
]);

export function createP2pManagementHandler(service) {
  return async (request, response, path) => {
    try {
      const action = actions.get(path);
      if (!action) throw fail("P2P 操作不存在", 404);
      if (request.method !== (action === "status" ? "GET" : "POST"))
        throw fail("P2P 请求方法无效", 405);
      const input =
        action === "create" || action === "revoke"
          ? await readObject(request, 2048)
          : undefined;
      json(response, 200, await service.manage(action, input));
    } catch (error) {
      json(response, Number.isInteger(error.cause) ? error.cause : 500, {
        error: Number.isInteger(error.cause)
          ? error.message
          : "P2P 设置更新失败",
      });
    }
  };
}

export async function openSignalingServer({
  assetsDirectory,
  getOrigin,
  negotiate,
}) {
  const serveStatic = createStaticHandler(assetsDirectory);
  let requests = 0;

  async function handle(request, response) {
    const origin = getOrigin();
    if (!origin || request.headers.host !== new URL(origin).host)
      return json(response, 421, { error: "P2P 地址不可用" });
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "script-src 'self' 'wasm-unsafe-eval'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'self' blob:; form-action 'none'; upgrade-insecure-requests",
    );
    const path = request.url?.split("?", 1)[0];
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/p2p") return serveStatic(request, response, "/");
      if (path !== "/" && /^\/[\w.-]+\.(js|css|ico|png)$/.test(path || ""))
        return serveStatic(request, response, path);
    }
    if (request.method !== "POST" || path !== "/p2p/offer")
      return json(response, 404, { error: "资源不存在" });
    if (
      request.headers.origin !== origin ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return json(response, 403, { error: "P2P 信令请求来源无效" });
    if (requests >= 24)
      return json(response, 429, { error: "P2P 信令繁忙，请稍后重试" });
    requests++;
    const abort = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) abort.abort();
    });
    try {
      const input = await readObject(request, 65536);
      json(response, 200, await negotiate(input, abort.signal));
    } finally {
      requests--;
    }
  }

  const server = createServer(
    {
      requestTimeout: 15000,
      headersTimeout: 8000,
      connectionsCheckingInterval: 2000,
    },
    (request, response) => {
      handle(request, response).catch((error) => {
        if (response.headersSent) return response.destroy();
        response.setHeader("Connection", "close");
        json(response, Number.isInteger(error.cause) ? error.cause : 500, {
          error: Number.isInteger(error.cause)
            ? error.message
            : "P2P 信令处理失败",
        });
      });
    },
  );
  server.setTimeout(15000);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
