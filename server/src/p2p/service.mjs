import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fail, openSignalingServer } from "./http.mjs";
import { createPeerRegistry } from "./peers.mjs";
import { readPrivateJson, writePrivateJson } from "./storage.mjs";
import { runPublicTunnel } from "./tunnel.mjs";

export { createP2pManagementHandler } from "./http.mjs";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[a-f0-9-]{36}$/;

function asHttpsOrigin(input) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.href !== `${url.origin}/`)
    throw new Error("P2P 域名须为 HTTPS 来源地址");
  return url.origin;
}

function validSettings(value) {
  return (
    typeof value?.enabled === "boolean" &&
    (value.origin === null || asHttpsOrigin(value.origin) === value.origin) &&
    Array.isArray(value.links) &&
    (!value.links.length || Boolean(value.origin)) &&
    value.links.every(
      ({ id, label, createdAt, token }) =>
        idPattern.test(id) &&
        typeof label === "string" &&
        typeof createdAt === "string" &&
        tokenPattern.test(token),
    )
  );
}

export function createP2pService({
  configDirectory,
  assetsDirectory,
  connectPeer,
  revokeLink,
  runTunnel = runPublicTunnel,
}) {
  const directory = join(configDirectory, "p2p");
  const settingsFile = join(directory, "links.json");
  let settings = { enabled: false, origin: null, links: [] };
  let state = "disabled";
  let error = null;
  let settingsError = false;
  let stopped = false;
  let active;
  let queue = Promise.resolve();
  let tokens = new Map();

  function serial(action) {
    const update = queue.then(action);
    queue = update.catch(() => {});
    return update;
  }

  function apply(next) {
    settings = next;
    tokens = new Map(next.links.map(({ token, id }) => [token, id]));
  }

  async function save(next) {
    await writePrivateJson(settingsFile, next);
    apply(next);
  }

  function publicLink({ id, label, createdAt, token }) {
    return { id, label, createdAt, url: `${settings.origin}/p2p#${token}` };
  }

  function status() {
    return {
      enabled: settings.enabled,
      state,
      origin: settings.origin,
      error,
      links: settings.links.map(publicLink),
    };
  }

  async function serve(lifetime) {
    const signal = lifetime.controller.signal;
    const current = () => settings.enabled && !signal.aborted && !stopped;
    let local;
    try {
      const sdk = await import("node-datachannel").catch(() => {
        throw new Error("当前安装缺少可用的 WebRTC 原生组件");
      });
      if (!current()) return;
      lifetime.peers = createPeerRegistry(sdk.PeerConnection, connectPeer);
      local = await openSignalingServer({
        assetsDirectory,
        getOrigin: () => (current() ? lifetime.origin : null),
        negotiate({ token, sdp }, requestSignal) {
          const id = typeof token === "string" && tokens.get(token);
          if (!current() || !id) throw fail("P2P 链接无效或已撤销", 401);
          return lifetime.peers.offer(id, sdp, requestSignal);
        },
      });
      if (!current()) return;
      await runTunnel({
        directory,
        port: local.address().port,
        signal,
        onOrigin: (url) =>
          serial(async () => {
            if (!current()) return;
            const origin = asHttpsOrigin(url);
            if (settings.origin !== origin) {
              if (settings.links.length)
                throw new Error("OpenTunnel 域名与已有链接不匹配");
              await save({ ...settings, origin });
            }
            lifetime.origin = origin;
          }),
        onState(next, message = null) {
          if (!current()) return;
          state = next;
          error = message;
        },
      });
    } catch (cause) {
      if (current()) {
        state = "error";
        error = cause.message;
      }
    } finally {
      lifetime.peers?.close();
      if (local) {
        await new Promise((resolve) => {
          local.close(resolve);
          local.closeAllConnections();
        });
      }
    }
  }

  function startTunnel() {
    if (active || !settings.enabled || stopped) return;
    state = "connecting";
    error = null;
    const lifetime = { controller: new AbortController(), origin: null };
    active = lifetime;
    lifetime.done = serve(lifetime).finally(() => {
      active = undefined;
      if (lifetime.controller.signal.aborted) startTunnel();
    });
  }

  function stopTunnel() {
    active?.peers?.close();
    active?.controller.abort();
  }

  return {
    async start() {
      try {
        const stored = await readPrivateJson(settingsFile);
        if (stored !== undefined) {
          if (!validSettings(stored)) throw new Error("P2P 设置格式错误");
          apply(stored);
        }
      } catch {
        settingsError = true;
        state = "error";
        error = "无法读取 P2P 设置文件";
      }
      startTunnel();
    },
    async close() {
      stopped = true;
      stopTunnel();
      await queue;
      await active?.done;
    },
    manage(action, input = {}) {
      return serial(async () => {
        if (action === "status") return status();
        if (stopped || settingsError)
          throw fail(error || "P2P 服务已停止", 503);
        if (action === "enable" || action === "disable") {
          const enabled = action === "enable";
          if (settings.enabled !== enabled)
            await save({ ...settings, enabled });
          if (enabled) {
            if (active?.controller.signal.aborted) state = "connecting";
            startTunnel();
          } else {
            state = "disabled";
            error = null;
            stopTunnel();
          }
        } else if (action === "create") {
          if (!settings.enabled || state !== "online" || !settings.origin)
            throw fail("请在 P2P 已连接后创建链接", 409);
          const label =
            typeof input.label === "string" ? input.label.trim() : "";
          if (
            (input.label !== undefined && typeof input.label !== "string") ||
            [...label].length > 80 ||
            /\p{Cc}/u.test(label)
          )
            throw fail("链接名称须为 80 字以内的文本", 400);
          const link = {
            id: randomUUID(),
            label: label || "远程访问",
            createdAt: new Date().toISOString(),
            token: randomBytes(32).toString("base64url"),
          };
          await save({ ...settings, links: [...settings.links, link] });
          return { ...status(), created: publicLink(link) };
        } else if (action === "revoke") {
          const links = settings.links.filter(({ id }) => id !== input.id);
          if (links.length === settings.links.length)
            throw fail("P2P 链接不存在", 404);
          await save({ ...settings, links });
          active?.peers?.close(input.id);
          await revokeLink?.(input.id);
        } else {
          throw fail("P2P 操作不存在", 404);
        }
        return status();
      });
    },
  };
}
