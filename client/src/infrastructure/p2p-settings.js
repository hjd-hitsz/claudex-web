export async function requestP2pSettings(action, data, signal) {
  const response = await fetch(action ? `/api/p2p/${action}` : "/api/p2p", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    ...(action && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  });
  const status = await response.json().catch(() => null);
  if (!response.ok || !status)
    throw new Error(status?.error || `P2P 设置请求失败（${response.status}）`);
  return status;
}
