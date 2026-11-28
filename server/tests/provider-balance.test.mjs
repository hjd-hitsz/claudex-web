import test from "node:test";
import assert from "node:assert/strict";
import {
  readProviderBalance,
  readProviderUsage,
  supportsProviderUsage,
} from "../src/backends/claude/provider-balance.mjs";
import { claudeAccountIdentity } from "../src/backends/claude/account.mjs";

test("DeepSeek 官方余额保留币种、零余额与不可用状态，凭据仅用于官方请求", async () => {
  const provider = {
    id: "deepseek",
    preset: true,
    usage: "deepseek-balance",
    apiKey: "test-key",
  };
  assert.equal(claudeAccountIdentity({}, provider).usageSupported, true);
  assert.equal(supportsProviderUsage({ id: "custom" }), false);
  const rows = ["CNY", "USD"].map((currency) => ({
    currency,
    total_balance: "0.00",
    granted_balance: "0",
    topped_up_balance: "0",
  }));
  const result = await readProviderBalance(provider, async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/user/balance");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.equal(options.redirect, "error");
    return {
      ok: true,
      json: async () => ({ is_available: false, balance_infos: rows }),
    };
  });
  assert.deepEqual(result.rateLimits.balances, rows);
  assert.equal(result.rateLimits.balanceAvailable, false);
  assert.equal(JSON.stringify(result).includes("test-key"), false);
});

test("Go 使用订阅额度窗口，并区分凭据无效和订阅不可用", async () => {
  const provider = {
    id: "opencode-go",
    preset: true,
    usage: "opencode-go-usage",
    apiKey: "fixture-key",
  };
  assert.equal(claudeAccountIdentity({}, provider).usageSupported, true);
  const resetsAt = "2026-11-28T12:10:00.000Z";
  const snapshot = await readProviderUsage(provider, async (url, options) => {
    assert.equal(url, "https://opencode.ai/inference/go/v1/usage");
    assert.equal(options.headers.Authorization, "Bearer fixture-key");
    assert.equal(options.redirect, "error");
    return {
      ok: true,
      json: async () => ({
        usage: Object.fromEntries(
          ["rolling", "weekly", "monthly"].map((id, index) => [
            id,
            {
              status: index === 0 ? "rate-limited" : "ok",
              percent: index === 0 ? 100 : 0,
              resetsAt,
            },
          ]),
        ),
      }),
    };
  });
  assert.deepEqual(
    snapshot.rateLimits.windows.map(({ usedPercent }) => usedPercent),
    [100, 0, 0],
  );
  assert.equal(
    snapshot.rateLimits.windows[0].resetsAt,
    Date.parse(resetsAt) / 1000,
  );
  await assert.rejects(
    readProviderUsage(provider, async () => ({ status: 401 })),
    /API Key 无效/,
  );
  await assert.rejects(
    readProviderUsage(provider, async () => ({ status: 403 })),
    /无法使用 OpenCode Go 订阅/,
  );
  await assert.rejects(
    readProviderUsage(provider, async () => ({
      ok: true,
      json: async () => ({}),
    })),
    /格式无效/,
  );
});

test("余额接口错误及无效响应提供可重试错误", async () => {
  await assert.rejects(
    readProviderBalance({}, async () => ({ ok: false, status: 401 })),
    /HTTP 401/,
  );
  await assert.rejects(
    readProviderBalance({}, async () => ({ ok: true, json: async () => ({}) })),
    /格式无效/,
  );
});
