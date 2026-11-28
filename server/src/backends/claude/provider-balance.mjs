// 只向官方服务发送对应供应商的凭据，第三方代理保留独立计费语义。
export function supportsProviderUsage(provider) {
  return provider?.preset === true && usageReaders.has(provider.usage);
}

async function readGoUsage(provider, fetchUsage = fetch) {
  const response = await fetchUsage(
    "https://opencode.ai/inference/go/v1/usage",
    {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  if (response.status === 401)
    throw new Error("OpenCode Go API Key 无效（HTTP 401）");
  if (response.status === 403)
    throw new Error("此 API Key 无法使用 OpenCode Go 订阅（HTTP 403）");
  if (!response.ok)
    throw new Error(`OpenCode Go 额度查询失败（HTTP ${response.status}）`);
  const { usage } = await response.json();
  const windows = [
    ["rolling", "5 小时额度", "5h", 300],
    ["weekly", "周额度", "周", 10080],
    ["monthly", "月额度", "月", null],
  ].map(([id, label, shortLabel, windowDurationMins]) => {
    const meter = usage?.[id];
    const resetsAt = Date.parse(meter?.resetsAt) / 1000;
    if (
      !["ok", "rate-limited"].includes(meter?.status) ||
      !Number.isFinite(meter.percent) ||
      meter.percent < 0 ||
      meter.percent > 100 ||
      !Number.isFinite(resetsAt)
    )
      throw new Error("OpenCode Go 额度响应格式无效");
    return {
      id,
      label,
      shortLabel,
      windowDurationMins,
      usedPercent: meter.percent,
      resetsAt,
    };
  });
  return {
    rateLimits: { limitId: provider.id, windows },
    availability: "available",
    providerId: provider.id,
  };
}

const usageReaders = new Map([
  ["deepseek-balance", readProviderBalance],
  ["opencode-go-usage", readGoUsage],
]);

export function readProviderUsage(provider, fetchUsage = fetch) {
  return usageReaders.get(provider.usage)(provider, fetchUsage);
}

export async function readProviderBalance(provider, fetchBalance = fetch) {
  const response = await fetchBalance("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`DeepSeek 余额查询失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (
    typeof data.is_available !== "boolean" ||
    !Array.isArray(data.balance_infos) ||
    data.balance_infos.some(
      (row) =>
        !["CNY", "USD"].includes(row.currency) ||
        [row.total_balance, row.granted_balance, row.topped_up_balance].some(
          (value) =>
            typeof value !== "string" ||
            !value.trim() ||
            !Number.isFinite(Number(value)),
        ),
    )
  )
    throw new Error("DeepSeek 余额响应格式无效");
  return {
    rateLimits: {
      limitId: "deepseek",
      windows: [],
      balances: data.balance_infos,
      balanceAvailable: data.is_available,
    },
    availability: "available",
    providerId: provider.id,
  };
}
