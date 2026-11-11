export async function requestServiceMaintenance(action, signal) {
  const response = await fetch(
    `/api/maintenance${action ? "/" + action : ""}`,
    {
      method: action ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: signal || AbortSignal.timeout(20000),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "服务维护请求失败");
  return data;
}
