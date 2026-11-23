import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInputStream } from "../../server/src/backends/claude/input-stream.mjs";
import { providerRuntimeEnvironment } from "../../server/src/backends/claude/provider-environment.mjs";
import { workspaceToolsForClaude } from "../../server/src/backends/claude/workspace-tools.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";

const root = await mkdtemp(join(tmpdir(), "claudex-claude-workspace-tools-"));
const cwd = join(root, "workspace");
await mkdir(cwd);
await writeFile(join(cwd, "alpha.txt"), "a-one\na-two\na-three\na-four\n");
await writeFile(join(cwd, "beta.txt"), "b-one\nb-two\n");
await writeFile(join(cwd, "private.txt"), "PRIVATE-FIXTURE\n");
let request;
let stage = 0;
const name = "mcp__claudex__read";
const service = await messagesServer((input) => {
  if (!input.tools?.some((tool) => tool.name === name))
    return [{ type: "text", text: "Isolated fixture" }];
  if (stage++ === 0)
    return [
      {
        type: "tool_use",
        name,
        id: "toolu_workspace_files",
        input: {
          files: [
            { path: "alpha.txt", start: 1, end: 2 },
            { path: "alpha.txt", start: 2, end: 4 },
            { path: "beta.txt", start: 1, end: 1 },
            { path: "private.txt", start: 1, end: 1 },
          ],
        },
      },
    ];
  request = input;
  return [{ type: "text", text: "Complete" }];
});
const id = randomUUID();
const input = createInputStream();
const backend = { dataDir: join(root, "config") };
const provider = {
  id: "fixture",
  protocol: "messages",
  baseUrl: service.url,
  apiKey: "fixture",
  models: ["claude-sonnet-4-6"],
};
let native;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 20_000);
try {
  native = query({
    prompt: input,
    options: {
      cwd,
      env: providerRuntimeEnvironment(provider, backend),
      pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE || "claude",
      sessionId: id,
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: [],
      abortController: controller,
      settings: { permissions: { deny: ["Read(./private.txt)"] } },
      mcpServers: workspaceToolsForClaude({
        cwd,
        readFile: (...args) => native.readFile(...args),
      }),
    },
  });
  input.push({
    type: "user",
    uuid: randomUUID(),
    session_id: id,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text: "Read the sample files." }],
    },
  });
  for await (const item of native) {
    if (item.type === "result") break;
  }
  assert.ok(request, "Claude received the MCP results");
  const result = request.messages
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .find((part) => part.tool_use_id === "toolu_workspace_files");
  assert.match(JSON.stringify(result), /alpha.txt:1-4/);
  assert.match(JSON.stringify(result), /beta.txt:1-1/);
  assert.match(JSON.stringify(result), /native read permissions/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-FIXTURE/);
  console.log(
    "Claude Code: in-process MCP read, range merging, and native path denial passed.",
  );
} finally {
  clearTimeout(timeout);
  input.close();
  native?.close();
  await service.close();
  await rm(root, { recursive: true, force: true });
}
