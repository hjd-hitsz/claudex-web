import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClaudeCatalogue } from "../src/backends/claude/catalogue.mjs";
import { createExecutionSession } from "../src/backends/claude/execution-session.mjs";
import {
  claudeConversationServerName,
  delegationToolName,
} from "../src/conversation-manager/tools.mjs";

const cli = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(1);
if (args[0] === "plugin") {
  console.log("[]");
} else {
  const value = args[args.indexOf("--settings") + 1];
  const settings = JSON.parse(value.startsWith("{") ? value : fs.readFileSync(value, "utf8"));
  fs.writeFileSync("settings-used.json", JSON.stringify({
    settings,
    sources: args.find((flag) => flag.startsWith("--setting-sources="))?.split("=")[1],
  }));
  const replies = {
    initialize: { commands: [], agents: [], account: {}, hook_on_failure_supported: true },
    list_models: { models: [] },
    mcp_status: { mcpServers: [{
      name: ${JSON.stringify(claudeConversationServerName)},
      source: "sdk",
      status: "connected",
      tools: [{ name: ${JSON.stringify(delegationToolName)} }],
    }] },
  };
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type !== "control_request") return;
    console.log(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: replies[message.request.subtype] || {},
      },
    }));
  });
}`;

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "claudex-attribution-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return {
    cwd,
    backend: {
      id: "claude",
      executable: process.execPath,
      dataDir: cwd,
      args: ["--eval", cli, "--"],
    },
    providers: { get: async () => null },
  };
}

async function assertFlagSettings(cwd) {
  const { settings, sources } = JSON.parse(
    await readFile(join(cwd, "settings-used.json"), "utf8"),
  );
  assert.deepEqual(settings.attribution, {
    commit: "",
    pr: "",
    sessionUrl: false,
  });
  assert.equal(settings.includeGitInstructions, false);
  assert.equal(sources, "user,project,local");
}

test("独立目录查询通过 Claude SDK 关闭 Git 指引及提交与 PR 归因", async (t) => {
  const { cwd, backend, providers } = await fixture(t);
  const catalogue = createClaudeCatalogue({ backend, providers });
  try {
    await catalogue.read({ cwd });
    await assertFlagSettings(cwd);
  } finally {
    catalogue.close();
  }
});

for (const [role, options] of [
  ["常规轮次", {}],
  ["委派执行", { delegation: "implementation" }],
  ["秘书执行", { secretaryRole: "秘书测试角色" }],
]) {
  test(`${role}通过 Claude SDK 关闭 Git 指引及提交与 PR 归因`, async (t) => {
    const { cwd, backend, providers } = await fixture(t);
    const run = await createExecutionSession({
      backend,
      providers,
      session: { id: randomUUID(), cwd },
      queued: {
        id: randomUUID(),
        mode: "default",
        delegation: options.delegation,
      },
      secretaryRole: options.secretaryRole,
      callConversationTool: async () => {},
      save: async () => {},
      questions: new Map(),
      current: () => null,
    });
    try {
      await run.prewarm;
      await assertFlagSettings(cwd);
    } finally {
      run.close();
      await run.done;
    }
  });
}
