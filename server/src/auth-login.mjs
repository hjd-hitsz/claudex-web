import { randomBytes } from "node:crypto";
import { authenticateSystemUser } from "./system-auth.mjs";

const challengeSeconds = 600;
const expiredMessage = "本次验证已结束，请重新输入系统密码。";
export const localSessionBinding = "local";

export function createLoginFlow({ config, username, totp, issueSession }) {
  const challenges = new Map();
  const attempts = new Map();
  let active = 0;
  let globalAttempts = [];

  function limit(address) {
    const now = Date.now();
    for (const [ip, record] of attempts)
      if (record.until <= now) attempts.delete(ip);
    globalAttempts = globalAttempts.filter((time) => time > now - 60000);
    const record = attempts.get(address) || {
      count: 0,
      until: now + 15 * 60000,
    };
    if (
      active >= 2 ||
      record.count >= 10 ||
      globalAttempts.length >= 30 ||
      attempts.size >= 1024
    )
      throw new Error("登录尝试过于频繁，请稍后重试。", { cause: 429 });
    record.count++;
    attempts.set(address, record);
    globalAttempts.push(now);
  }

  function find(token, scope) {
    const challenge = challenges.get(token);
    if (challenge?.expiresAt <= Date.now()) challenges.delete(token);
    else if (challenge?.scope === scope) return challenge;
  }

  function cancel(token, scope) {
    if (find(token, scope)) challenges.delete(token);
  }

  function describe(challenge) {
    return {
      authenticated: false,
      requiresTotp: true,
      expiresAt: challenge.expiresAt,
      totpStatus: totp.state().status,
    };
  }

  function start(scope) {
    const now = Date.now();
    for (const [token, challenge] of challenges)
      if (challenge.expiresAt <= now) challenges.delete(token);
    if (challenges.size >= 128)
      throw new Error("待验证的登录过多，请稍后重试。", { cause: 429 });
    const token = randomBytes(32).toString("base64url");
    const challenge = {
      scope,
      expiresAt: now + challengeSeconds * 1000,
      failures: 0,
    };
    challenges.set(token, challenge);
    return { pendingToken: token, session: describe(challenge) };
  }

  return {
    challengeSeconds,
    cancel,
    pending(token, scope) {
      const challenge = find(token, scope);
      if (!challenge || totp.state().status === "disabled") return;
      return describe(challenge);
    },
    async login(
      readInput,
      attemptKey,
      { scope, pendingToken, ...options } = {},
    ) {
      limit(attemptKey);
      cancel(pendingToken, scope);
      active++;
      try {
        const { username: submitted, password } = (await readInput()) || {};
        if (
          typeof submitted !== "string" ||
          typeof password !== "string" ||
          !submitted ||
          !password ||
          submitted.length > 256 ||
          password.length > 1024 ||
          /\0/.test(submitted + password)
        )
          throw new Error("请输入有效的系统用户名和密码。", { cause: 400 });
        if (
          submitted !== username ||
          !(await authenticateSystemUser(submitted, password, config))
        )
          throw new Error(
            "用户名或密码错误，或系统账户不可用。请使用运行服务的系统账户。",
            { cause: 401 },
          );
        options.signal?.throwIfAborted();
        if (options.local)
          return await issueSession({
            ...options,
            binding: localSessionBinding,
          });
        const mode = totp.state();
        if (mode.status !== "disabled") return start(scope);
        return await issueSession({ ...options, binding: mode.binding });
      } finally {
        active--;
      }
    },
    async verify(input, attemptKey, { scope, pendingToken, ...options }) {
      const challenge = find(pendingToken, scope);
      if (!challenge) throw new Error(expiredMessage, { cause: 410 });
      if (typeof input?.code !== "string" || !/^\d{6}$/.test(input.code))
        throw new Error("请输入验证器中的 6 位动态码。", { cause: 400 });
      limit(`totp:${attemptKey}`);
      options.signal?.throwIfAborted();
      const { status: result, binding } = totp.verify(input.code);
      if (result === "unconfigured")
        throw new Error("请先按下方步骤绑定验证器。", { cause: 409 });
      if (result === "invalid" && ++challenge.failures < 5)
        throw new Error("动态码错误、已使用或已过期，请输入验证器中的新码。", {
          cause: 401,
        });
      challenges.delete(pendingToken);
      if (result !== "verified")
        throw new Error(expiredMessage, { cause: 410 });
      return issueSession({ ...options, binding });
    },
  };
}
