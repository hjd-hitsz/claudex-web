import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const compress = promisify(gzip);
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/favicon.ico", ["favicon.ico", "image/x-icon"]],
  ["/favicon.png", ["favicon.png", "image/png"]],
  ["/apple-touch-icon.png", ["apple-touch-icon.png", "image/png"]],
]);
const types = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
};
const scripts = new Set(["/notification-worker.js", "/p2p-sw.js"]);
const fontAsset = /^\/(font-[\w-]+\.(woff2?|ttf))$/;
const codeAsset = /^\/([\w.-]+\.(js|css))$/;

function resolveAsset(path) {
  const builtin = files.get(path);
  if (builtin) return [...builtin, "no-store", true];
  const font = path.match(fontAsset);
  if (font)
    return [
      font[1],
      types[font[2]],
      "public, max-age=31536000, immutable",
      false,
    ];
  const code = path.match(codeAsset);
  if (code)
    return [
      code[1],
      types[code[2]],
      scripts.has(path) ? "no-store" : "public, no-cache",
      true,
    ];
}

export function isStaticAsset(path) {
  return path !== "/" && Boolean(resolveAsset(path));
}

function representation(bytes, cachePolicy) {
  return {
    bytes,
    ...(cachePolicy !== "no-store" && {
      tag: '"' + createHash("sha256").update(bytes).digest("base64url") + '"',
    }),
  };
}

async function loadAsset(path, cachePolicy, compressible) {
  const raw = await readFile(path);
  return {
    raw: representation(raw, cachePolicy),
    ...(compressible && {
      gzip: representation(await compress(raw), cachePolicy),
    }),
  };
}

export function createStaticHandler(staticDir) {
  const staticCache = new Map();
  return async function serveStatic(request, response, path) {
    const file = resolveAsset(path);
    if (!file) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const [name, type, cachePolicy, compressible] = file;
    const filename = join(staticDir, name);
    let entry;
    try {
      const { ino, ctimeMs, mtimeMs, size } = await stat(filename);
      const revision = `${ino}:${ctimeMs}:${mtimeMs}:${size}`;
      entry = staticCache.get(path);
      if (entry?.revision !== revision) {
        entry = {
          revision,
          content: loadAsset(filename, cachePolicy, compressible),
        };
        staticCache.set(path, entry);
      }
      const content = await entry.content;
      const compressed =
        compressible &&
        /\bgzip\b/.test(request.headers["accept-encoding"] || "");
      const { bytes, tag } = compressed ? content.gzip : content.raw;
      const headers = {
        "Content-Type": type,
        "Cache-Control": cachePolicy,
        ...(compressible && { Vary: "Accept-Encoding" }),
        ...(tag && { ETag: tag }),
        ...(compressed ? { "Content-Encoding": "gzip" } : {}),
      };
      const validators = request.headers["if-none-match"]?.split(",") || [];
      const unchanged =
        tag &&
        (request.method === "GET" || request.method === "HEAD") &&
        validators.some((value) => {
          const validator = value.trim().replace(/^W\//, "");
          return validator === tag || validator === "*";
        });
      if (unchanged) return response.writeHead(304, headers).end();
      response.writeHead(200, { ...headers, "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (staticCache.get(path) === entry) staticCache.delete(path);
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      console.error("Static file:", error.message);
      response.writeHead(500);
      response.end("Unable to load page");
    }
  };
}
