import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { tunnelStorage } from "./storage.mjs";

const profile = "claudex-web";
const route = "@";

export async function runPublicTunnel({
  directory,
  port,
  signal,
  onOrigin,
  onState,
}) {
  const endpoint = new URL(
    process.env.OPENTUNNEL_API || "https://opentunnel.xyz",
  );
  if (endpoint.protocol !== "https:" || endpoint.href !== `${endpoint.origin}/`)
    throw new Error("OPENTUNNEL_API 须为 HTTPS 来源地址");
  const { create } = await import("@opentunnel/client");
  const store = await tunnelStorage(
    join(directory, "tunnel.json"),
    endpoint.origin,
    profile,
  );
  const client = create({ api: endpoint, store });
  let retry = 1000;

  async function attach(connection, activeSignal) {
    let accepted = false;
    const events = (async () => {
      for await (const { type } of connection.events) {
        if (!accepted || activeSignal.aborted) continue;
        if (type === "connected") onState("online");
        if (type === "disconnected" || type === "reconnecting")
          onState("connecting");
      }
    })();
    const closed = Promise.all([connection.closed, events]);
    void closed.catch(() => {});
    try {
      if (!activeSignal.aborted) {
        await onOrigin(connection.urls[route]);
        accepted = true;
        onState(
          connection.status().state === "connected" ? "online" : "connecting",
        );
      }
      await closed;
    } finally {
      await connection.close();
      await closed.catch(() => {});
    }
  }

  try {
    while (!signal.aborted) {
      onState("connecting");
      const timeout = new AbortController();
      const activeSignal = AbortSignal.any([signal, timeout.signal]);
      const timer = setTimeout(() => timeout.abort(), 90000);
      timer.unref();
      let routeConflict = false;
      try {
        const connection = await client.tunnel.connect({
          profile,
          routes: { [route]: `127.0.0.1:${port}` },
          signal: activeSignal,
          onRouteConflict: "fail",
          onEvent(event) {
            if (event.type === "route-conflict") routeConflict = true;
          },
        });
        clearTimeout(timer);
        retry = 1000;
        await attach(connection, activeSignal);
      } catch {
        if (!signal.aborted)
          onState(
            "error",
            routeConflict
              ? "OpenTunnel 域名被另一进程占用，正在重试"
              : "OpenTunnel 暂不可用，正在重试",
          );
      } finally {
        clearTimeout(timer);
      }
      if (signal.aborted) break;
      await wait(retry, undefined, { signal }).catch(() => {});
      retry = Math.min(retry * 2, 30000);
    }
  } finally {
    await client.dispose();
  }
}
