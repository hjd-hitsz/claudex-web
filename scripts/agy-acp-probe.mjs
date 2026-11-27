import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { secretaryAgent } from "../server/src/backends/agy/secretary-prompts.mjs";

// 候选方法仅探测固定名称。操作均限定在临时空会话中。
function methods(cwd, sessionId) {
  const session = { sessionId };
  const workspace = { cwd, mcpServers: [] };
  const thread = { threadId: sessionId };
  return [
    ["session/list", { cwd }],
    ["session/load", { ...session, ...workspace }],
    ["session/resume", { ...session, ...workspace }],
    ["session/set_mode", { ...session, modeId: "plan" }],
    [
      "session/set_config_option",
      { ...session, configId: "mode", value: "accept-edits" },
    ],
    ["session/fork", { ...session, ...workspace }],
    ["session/fork_at", { ...session, ...workspace }],
    ["session/rewind", session],
    ["session/revert", session],
    ["session/rollback", session],
    ["session/undo", session],
    ["session/restore", session],
    ["session/set_title", { ...session, title: "ACP probe" }],
    ["session/rename", { ...session, title: "ACP probe" }],
    ["review/start", thread],
    ["session/review", session],
    ["session/tasks/list", session],
    ["session/subagents/list", session],
    ["thread/backgroundTasks/list", thread],
    ["thread/backgroundTerminals/list", thread],
    ["skills/list", { cwd }],
    ["session/skills/list", session],
    ["session/commands/list", session],
    ["agent/usage", {}],
    ["agent/quota", {}],
    ["plugin/installed", { cwd }],
    ["mcpServerStatus/list", { cwd }],
    ["session/steer", session],
    ["turn/steer", thread],
    ["session/close", session],
    ["session/archive", session],
    ["session/unarchive", session],
    ["session/delete", session],
  ];
}

async function probeEnvironment(root) {
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const config = join(home, ".gemini", "antigravity-cli");
  const directories = {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "run"),
    XDG_CONFIG_DIRS: join(root, "global-config"),
    XDG_DATA_DIRS: join(root, "global-data"),
    TMPDIR: join(root, "tmp"),
  };
  await Promise.all(
    [cwd, config, ...Object.values(directories)].map((dir) =>
      mkdir(dir, { recursive: true, mode: 0o700 }),
    ),
  );
  const skill = join(cwd, ".agents", "skills", "probe-skill");
  const secretary = join(cwd, ".agents", "agents", "claudex-secretary");
  await Promise.all(
    [skill, secretary].map((dir) => mkdir(dir, { recursive: true })),
  );
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: probe-skill\ndescription: ACP probe skill\n---\n\nProbe instructions.\n",
  );
  await writeFile(join(secretary, "agent.md"), secretaryAgent);

  // Gemini 提供方允许用占位密钥创建会话，模型端点指向本地无效端口。
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      modelProvider: "gemini",
      auth: { type: "gemini-api-key" },
    }),
    { mode: 0o600 },
  );
  return {
    cwd,
    env: {
      ...directories,
      HOME: home,
      PATH: process.env.PATH,
      GEMINI_API_KEY: "claudex-probe-placeholder",
      GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:0",
    },
  };
}

function connect({ cwd, env }, agent) {
  const child = spawn(
    "agy",
    [
      "acp",
      "--disable-telemetry",
      "--include-default-customizations=false",
      ...(agent ? ["--agent=" + agent] : []),
    ],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let current;
  let failure;
  let sequence = 0;
  let stderr = "";
  const commandUpdates = [];
  function fail(error) {
    failure ??= error;
    current?.reject(failure);
  }

  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      const detail = stderr.trim();
      fail(
        new Error(
          `agy ACP 已退出（${signal || code}）${detail ? `：${detail}` : ""}`,
        ),
      );
      resolve();
    });
  });
  child.on("error", (error) =>
    fail(
      error.code === "ENOENT"
        ? new Error("PATH 中找不到 agy，请先安装 Antigravity CLI。")
        : error,
    ),
  );
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    let packet;
    try {
      packet = JSON.parse(line);
    } catch {
      fail(new Error("agy ACP 返回了无效的 JSON。"));
      return;
    }
    if (packet?.method) {
      if (packet.params?.update?.sessionUpdate === "available_commands_update")
        commandUpdates.push(packet.params.update.availableCommands);
      if (packet.id !== undefined)
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: packet.id,
            error: { code: -32601, message: "Probe client method not found" },
          }) + "\n",
        );
      return;
    }
    if (!current || packet?.id !== current.id) return;
    if (packet.jsonrpc !== "2.0" || (!("result" in packet) && !packet.error)) {
      fail(new Error("agy ACP 返回了无效的 JSON-RPC 响应。"));
      return;
    }
    current.resolve(packet);
  });
  return {
    commandUpdates,
    async call(method, params) {
      if (failure) throw failure;
      const id = ++sequence;
      const timer = setTimeout(
        () => fail(new Error(`${method} 请求超时。`)),
        10000,
      );
      try {
        return await new Promise((resolve, reject) => {
          current = { id, resolve, reject };
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          );
        });
      } finally {
        clearTimeout(timer);
        current = undefined;
      }
    },
    async close() {
      child.stdin.end();
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function setup(client, method, params) {
  const { result, error } = await client.call(method, params);
  if (error) throw new Error(`${method} 返回 ${error.code} ${error.message}`);
  return result;
}

async function probe(client, cwd) {
  const { protocolVersion, agentCapabilities, agentInfo, authMethods } =
    await setup(client, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "claudex-agy-acp-probe", version: "1" },
    });
  if (protocolVersion !== 1)
    throw new Error(
      `agy 协商的 ACP 版本为 ${protocolVersion}，探测脚本要求版本 1。`,
    );

  const { sessionId } = await setup(client, "session/new", {
    cwd,
    mcpServers: [],
  });
  if (typeof sessionId !== "string" || !sessionId)
    throw new Error("session/new 未返回会话标识。");

  const result = {
    agyVersion: agentInfo?.version ?? null,
    protocolVersion,
    agentCapabilities,
    authMethods: authMethods?.map(({ id }) => id) ?? [],
    commandUpdates: client.commandUpdates,
    supported: ["initialize", "session/new"],
    missing: [],
    inconclusive: [],
  };
  for (const [method, params] of methods(cwd, sessionId)) {
    const { error } = await client.call(method, params);
    if (!error) result.supported.push(method);
    else if (error.code === -32601)
      result.missing.push({ method, code: error.code });
    else
      result.inconclusive.push({
        method,
        code: error.code,
        message: error.message,
      });
  }
  return result;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "claudex-agy-acp-probe-"));
  try {
    const environment = await probeEnvironment(root);
    const client = connect(environment);
    try {
      const result = await probe(client, environment.cwd);
      const secretary = connect(environment, "claudex-secretary");
      try {
        const role = await probe(secretary, environment.cwd);
        return { ...result, secretaryCommandUpdates: role.commandUpdates };
      } finally {
        await secretary.close();
      }
    } finally {
      await client.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
  console.error("agy ACP 探测失败：" + error.message);
  process.exitCode = 1;
}
