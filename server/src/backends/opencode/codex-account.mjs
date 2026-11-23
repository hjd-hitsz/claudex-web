import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findCli } from "../cli-installation.mjs";

export function createCodexAccountSource({
  codexHome,
  read = readCodexAccount,
}) {
  let cached,
    stamp,
    checked = 0,
    pending;
  const abort = new AbortController();
  async function current({ force = false } = {}) {
    if (!codexHome) return null;
    const revision = await stat(join(codexHome, "auth.json"))
      .then((s) => `${s.mtimeMs}:${s.size}`)
      .catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return "keyring";
      });
    if (
      !force &&
      revision === stamp &&
      Date.now() - checked < 60000 &&
      (!cached || cached.expires > Date.now() + 60000)
    )
      return cached;
    if (pending) return pending;
    pending = read({ codexHome, signal: abort.signal })
      .then((value) => {
        cached = value;
        stamp = revision;
        checked = Date.now();
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  return { read: current, close: () => abort.abort() };
}

// Codex owns credential storage and renewal, including keyring-backed logins.
// Only the access token crosses this private, short-lived stdio connection.
export async function readCodexAccount({ codexHome, signal }) {
  try {
    await stat(codexHome);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let executable;
  try {
    executable = await findCli("codex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!executable) return null;
  const child = spawn(
    executable,
    ["-c", 'model_provider="openai"', "app-server", "--listen", "stdio://"],
    {
      cwd: codexHome,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  function fail() {
    for (const p of pending.values())
      p.reject(new Error("读取本机 Codex 登录态失败，请检查 Codex 后端。"));
    pending.clear();
    child.kill();
  }
  const timer = setTimeout(fail, 20000);
  signal?.addEventListener("abort", fail, { once: true });
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error("Codex 账户接口调用失败。"));
    else request.resolve(message.result);
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    if (signal?.aborted) throw new Error("账户读取已取消。");
    await call("initialize", {
      clientInfo: { name: "claudex_opencode_auth", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
    let auth = await call("getAuthStatus", {
      includeToken: true,
      refreshToken: false,
    });
    if (auth.authMethod !== "chatgpt" || !auth.authToken) return null;
    const claims = (token) =>
      JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    if (claims(auth.authToken).exp * 1000 <= Date.now() + 60000)
      auth = await call("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      });
    if (auth.authMethod !== "chatgpt" || !auth.authToken) return null;
    const payload = claims(auth.authToken);
    const expires = payload.exp * 1000;
    const accountID =
      payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!accountID || !(expires > Date.now() + 60000))
      throw new Error("本机 Codex 登录已过期，请在 Codex 后端重新登录。");
    const [{ account }, models] = await Promise.all([
      call("account/read", { refreshToken: false }),
      call("model/list", { includeHidden: false }),
    ]);
    return {
      access: auth.authToken,
      expires,
      accountID,
      account,
      models: models.data.map((m) => m.model),
      modelCatalogue: models.data,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", fail);
    child.kill();
    lines.close();
  }
}
