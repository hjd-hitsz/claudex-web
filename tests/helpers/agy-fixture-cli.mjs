import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

if (process.argv.includes("--version")) {
  console.log("1.5.17");
  process.exit();
}
const sessions = new Map();
const callbacks = new Map();
let sequence = 0;
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const event = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const text = (sessionId, text, kind = "agent_message_chunk") =>
  event(sessionId, { sessionUpdate: kind, content: { type: "text", text } });

function startMcp(mcp) {
  let id = 0;
  const pending = new Map();
  const child = spawn(mcp.command, mcp.args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const packet = JSON.parse(line);
    pending.get(packet.id)?.(packet.result);
    pending.delete(packet.id);
  });
  const call = (method, params) =>
    new Promise((resolve) => {
      const key = ++id;
      pending.set(key, resolve);
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n",
      );
    });
  return {
    child,
    call,
    ready: call("initialize", { protocolVersion: "2025-03-26" })
      .then(() => call("tools/list", {}))
      .then((result) => {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/roots/list_changed",
          }) + "\n",
        );
        return result;
      }),
  };
}
function ask(sessionId, params) {
  const id = ++sequence;
  return new Promise((resolve) => {
    callbacks.set(id, resolve);
    send({
      id,
      method: "session/request_permission",
      params: { sessionId, ...params },
    });
  });
}

const compactor = process.argv.includes("--agent=claudex-compactor");

async function handle({ method, params: p }) {
  if (method === "initialize")
    return {
      protocolVersion: 1,
      agentInfo: { version: "1.5.17" },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, close: {} },
      },
      _meta: { antigravity: { systemPrompt: { append: true } } },
    };
  if (["session/new", "session/resume", "session/load"].includes(method)) {
    const sessionId = p.sessionId || randomUUID();
    if (
      !compactor &&
      !p._meta?.antigravity?.systemPrompt?.append.includes("秘书")
    )
      throw new Error("秘书提示词缺失");
    const history = join(p.cwd, sessionId + ".json");
    const items = await readFile(history, "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return [];
      });
    if (method === "session/load")
      for (const { content, reply } of items) {
        text(sessionId, content, "user_message_chunk");
        if (reply) text(sessionId, reply);
      }
    else
      sessions.set(sessionId, {
        history,
        items,
        mcp: p.mcpServers[0] && startMcp(p.mcpServers[0]),
        cwd: p.cwd,
      });
    return {
      sessionId,
      configOptions: [
        {
          category: "model",
          id: "model",
          currentValue: "fixture-gemini",
          options: [{ value: "fixture-gemini", name: "Fixture Gemini" }],
        },
      ],
    };
  }
  if (method === "session/cancel") {
    sessions.get(p.sessionId)?.waitingPrompt?.resolve("cancelled");
    return {};
  }
  if (method === "session/close") return {};
  if (method !== "session/prompt") throw new Error("不支持 " + method);
  const { sessionId, prompt } = p;
  if (compactor) {
    text(sessionId, JSON.stringify({ summary: "整理后的测试会话记录" }));
    return { stopReason: "end_turn" };
  }
  const session = sessions.get(sessionId);
  const content = prompt.map((part) => part.text || part.type).join("\n");
  // agy acknowledges the previous prompt when the replacement input is accepted.
  session.waitingPrompt?.resolve("end_turn");
  const waitingPrompt = /AGY_BROWSER_INTERRUPT|AGY_STEER/.test(content)
    ? Promise.withResolvers()
    : undefined;
  session.waitingPrompt = waitingPrompt;
  const record = { content };
  session.items.push(record);
  await writeFile(session.history, JSON.stringify(session.items));
  let reply = "秘书已核对内容";
  if (content.includes("AGY_BROWSER_TOOL_ERROR")) {
    const toolCallId = "fixture-command";
    const update = {
      toolCallId,
      kind: "execute",
      title: "ls fixture-missing.txt",
      rawInput: { CommandLine: "ls fixture-missing.txt" },
    };
    event(sessionId, {
      ...update,
      sessionUpdate: "tool_call",
      status: "in_progress",
    });
    const approval = await ask(sessionId, {
      options: [
        { optionId: "allow", kind: "allow_once", name: "允许一次" },
        { optionId: "reject", kind: "reject_once", name: "拒绝一次" },
      ],
      toolCall: { ...update, name: "run_command" },
    });
    if (approval?.outcome?.optionId !== "allow")
      throw new Error("工具请求未获同意");
    event(sessionId, {
      ...update,
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: {
        output: "ls: fixture-missing.txt：没有那个文件或目录",
        exit_code: 2,
      },
      content: [{ type: "content", content: { type: "text", text: "" } }],
    });
    text(sessionId, "<USER_SETTINGS_");
    text(
      sessionId,
      "CHANGE> The user changed setting Model Selection from None to Fixture Gemini. </USER_SETTINGS_CHANGE>",
    );
    reply = "文件不存在，已根据工具结果完成核对。";
  }
  if (content.includes("AGY_BROWSER_INTERRUPT")) {
    text(sessionId, "已开始处理旧要求。");
    return { stopReason: await waitingPrompt.promise };
  }
  if (content.includes("AGY_BROWSER_REPLACE")) reply = "秘书已处理新的要求";
  const route = /本轮用户选择的新委派执行端：(codex|claude)/.exec(content)?.[1];
  if (content.includes("AGY_REPLACE")) {
    const prior = session.items.findLast(
      ({ delegation }) => delegation,
    )?.delegation;
    await session.mcp.ready;
    const receipt = await session.mcp.call("tools/call", {
      name: "ask_" + prior.target,
      arguments: {
        task_id: prior.id,
        request_id: "replacement",
        request: "执行 AGY_REPLACE 最新要求",
      },
    });
    if (receipt?.structuredContent?.task_id !== prior.id)
      throw new Error("续问未受理：" + JSON.stringify(receipt));
    reply = "已转交新需求";
  } else if (route && !content.includes("AGY_SECRETARY_ONLY")) {
    const ready = await session.mcp.ready;
    const name = "ask_" + route;
    if (!ready.tools.some((tool) => tool.name === name))
      throw new Error("委派工具缺失");
    const scenario = [
      "AGY_BACKGROUND_TEST",
      "AGY_TAKEOVER_RUNNING",
      "AGY_TAKEOVER_APPROVAL",
    ].find((name) => content.includes(name));
    const args = {
      name,
      arguments: {
        request: ["检查并报告具体证据", scenario].filter(Boolean).join(" "),
        request_id:
          "start-" +
          route +
          (content.includes("AGY_BACKGROUND_TEST") ? "-background" : ""),
        scope: content.includes("AGY_BACKGROUND_TEST")
          ? "implementation"
          : "research",
      },
    };
    const receipt = await session.mcp.call("tools/call", args);
    const repeated = await session.mcp.call("tools/call", args);
    if (
      !receipt?.structuredContent?.task_id ||
      receipt.structuredContent.task_id !== repeated?.structuredContent?.task_id
    )
      throw new Error("MCP 去重失败");
    record.delegation = {
      target: route,
      id: receipt.structuredContent.task_id,
    };
    await writeFile(session.history, JSON.stringify(session.items));
    if (content.includes("AGY_STEER")) {
      return { stopReason: await waitingPrompt.promise };
    }
    reply = "已提交后台委派";
  }
  if (content.includes("[Claudex delegation notice:")) {
    const payload = JSON.parse(content.split("\n").at(-1));
    const call = payload.callChain?.find(({ action }) =>
      /(?:codex|claude)-release-1\b/.test(action),
    );
    if (call) {
      const { tools } = await session.mcp.ready;
      const name = "read_delegation_step";
      if (!tools.some((tool) => tool.name === name))
        throw new Error("详情工具缺失");
      const result = await session.mcp.call("tools/call", {
        name,
        arguments: {
          taskId: payload.taskId,
          stepId: payload.stepId,
          callId: call.callId,
        },
      });
      if (result.isError) throw new Error(result.content[0].text);
      record.evidence = result.structuredContent;
    }
    if (content.includes("FIXTURE_FOLLOWUP")) {
      await session.mcp.ready;
      await session.mcp.call("tools/call", {
        name: "ask_codex",
        arguments: {
          request: "补齐核对结果",
          request_id: "follow-up",
          task_id: payload.taskId,
        },
      });
      reply = "已提交原任务补问";
    } else if (content.includes("FIXTURE_WRITE")) {
      const approval = await ask(sessionId, {
        options: [{ optionId: "write", name: "允许一次", kind: "allow_once" }],
        toolCall: {
          kind: "edit",
          title: "保存报告",
          locations: [{ path: join(session.cwd, "report.md") }],
        },
      });
      if (approval?.outcome?.optionId === "write") {
        await writeFile(join(session.cwd, "report.md"), "# 已核对的文档\n");
        reply = "文档由秘书写入";
        event(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "write-report",
          status: "completed",
          title: "保存报告",
          content: [
            {
              type: "diff",
              path: join(session.cwd, "report.md"),
              oldText: null,
              newText: "# 已核对的文档\n",
            },
          ],
        });
      }
    }
  }
  if (content === "/compact") reply = "";
  if (reply) text(sessionId, reply);
  record.reply = reply;
  await writeFile(session.history, JSON.stringify(session.items));
  event(sessionId, { sessionUpdate: "usage_update", used: 42, size: 4096 });
  return { stopReason: "end_turn" };
}
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const packet = JSON.parse(line);
    if (!packet.method) {
      callbacks.get(packet.id)?.(packet.result);
      callbacks.delete(packet.id);
      return;
    }
    handle(packet).then(
      (result) => {
        if (packet.id !== undefined) send({ id: packet.id, result });
      },
      (error) => {
        if (packet.id !== undefined)
          send({
            id: packet.id,
            error: { code: -32000, message: error.message },
          });
      },
    );
  })
  .on("close", () => {
    for (const { mcp } of sessions.values()) mcp?.child.kill();
  });
