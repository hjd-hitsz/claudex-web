export async function requestTranslationSettings(enabled) {
  const response = await fetch("/api/translation", {
    method: enabled === undefined ? "GET" : "PUT",
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    ...(enabled !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "翻译设置读取失败");
  return data;
}
