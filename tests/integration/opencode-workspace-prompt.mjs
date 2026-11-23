import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadOpenCode } from "../../server/src/backends/opencode/runtime.mjs";
import { startWorkspaceTools } from "../../server/src/backends/opencode/workspace-tools.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";

const sdk = process.env.OPENCODE_SDK_ENTRY;
assert.ok(sdk, "Set OPENCODE_SDK_ENTRY to the OpenCode SDK entry");
const root = await mkdtemp(join(tmpdir(), "claudex-opencode-prompt-"));
for (const key of ["DATA", "CONFIG", "STATE", "CACHE"])
  process.env[`XDG_${key}_HOME`] = join(root, key.toLowerCase());
const cwd = join(root, "project");
const skillDir = join(root, "skills", "fixture-skill");
await mkdir(cwd);
await mkdir(skillDir, { recursive: true });
const project = "Project prompt fixture documents the `read` tool.";
const custom = "Custom agent fixture mentions the `read` tool.";
await writeFile(join(cwd, "AGENTS.md"), project + "\n");
await writeFile(
  join(skillDir, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Isolated prompt fixture\n---\nTest instructions.\n",
);
const models = [
  ["gpt-audit", "Communication"],
  ["claude-sonnet-4-6", "Code comments"],
  ["kimi-audit", "General Guidelines for Research and Data Processing"],
  ["trinity-audit", "Code References"],
  ["muse-audit", "Behavior - Verification"],
];
const text = (content) =>
  typeof content === "string"
    ? content
    : (content || []).map(({ text }) => text || "").join("\n");
const prompts = new Map();
const upstream = await messagesServer((request) => {
  if (request.tools?.length) {
    for (const message of request.messages) {
      const marker = /^prompt-fixture-[\w-]+$/.exec(text(message.content))?.[0];
      if (marker) prompts.get(marker)?.resolve(request);
    }
  }
  return [{ type: "text", text: "Prompt recorded" }];
});

const workspaceTools = await startWorkspaceTools();
let host;
try {
  const OpenCode = await loadOpenCode(resolve(sdk), { workspaceTools: true });
  const openHost = (optimized) =>
    OpenCode.create({
      database: { path: join(root, optimized ? "optimized.db" : "native.db") },
      config: {
        directory: join(root, "config"),
        claude: false,
        content: JSON.stringify({
          agents: { "fixture-custom": { mode: "primary", system: custom } },
          skills: { paths: [join(root, "skills")] },
          providers: {
            fixture: {
              package: "@ai-sdk/anthropic",
              settings: { baseURL: `${upstream.url}/v1`, apiKey: "fixture" },
              models: Object.fromEntries(
                models.map(([id]) => [id, { name: id }]),
              ),
            },
          },
        }),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: optimized ? [workspaceTools.plugin] : [],
    });
  async function capture(marker, model, options = {}) {
    marker = "prompt-fixture-" + marker;
    const captured = Promise.withResolvers();
    prompts.set(marker, captured);
    const session = await host.sessions.create({
      location: { directory: cwd },
      model: { providerID: "fixture", id: model },
      ...options,
    });
    await host.sessions.prompt({ sessionID: session.id, text: marker });
    return Promise.race([
      captured.promise,
      delay(8000, null, { ref: false }).then(() => {
        throw new Error(`Did not capture ${marker}`);
      }),
    ]);
  }
  host = await openHost(true);
  for (const [model, preservedHeading] of models) {
    const request = await capture(model, model);
    const system = text(request.system);
    assert.ok(system.includes(preservedHeading), model);
    assert.ok(system.includes(project), model);
    assert.match(system, /<id>fixture-skill<\/id>/);
    assert.match(system, /Use `claudex_skill`/);
    assert.match(system, /Use `claudex_web_search` to discover sources/);
    assert.match(
      system,
      /Use `claudex_shell` for commands and for searches that combine operations/,
    );
    assert.match(system, /Use `glob` when the task is to find paths/);
    assert.doesNotMatch(
      system.replace(project, ""),
      /`(?:read|write|edit|grep|shell|webfetch)`|Use the skill tool|(?:read|shell) tool\b|oldString/,
    );
    assert.equal(system.match(/# Workspace tools/g)?.length, 1);
    console.log(
      `${model}: complete tool section, native skills catalog, project and model guidance verified`,
    );
  }

  const customPrompt = text(
    (await capture("custom", models[0][0], { agent: "fixture-custom" })).system,
  );
  assert.ok(customPrompt.includes(custom));
  assert.match(customPrompt, /# Workspace tools/);

  const restricted = await capture("restricted", models[0][0], {
    permissions: [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "websearch", resource: "*", effect: "deny" },
    ],
  });
  assert.ok(!restricted.tools.some(({ name }) => name === "claudex_shell"));
  assert.doesNotMatch(text(restricted.system), /Use `claudex_shell`/);
  assert.ok(
    !restricted.tools.some(({ name }) => name === "claudex_web_search"),
  );
  assert.doesNotMatch(text(restricted.system), /Use `claudex_web_search`/);
  console.log(
    "Custom agent text preserved and tool guidance follows native permissions",
  );

  await host.close();
  host = await openHost(false);
  const native = await capture("native", models[0][0]);
  assert.ok(native.tools.some(({ name }) => name === "read"));
  assert.ok(native.tools.some(({ name }) => name === "websearch"));
  assert.match(text(native.system), /Use the skill tool/);
  assert.doesNotMatch(text(native.system), /# Workspace tools/);
  console.log(
    "Optimization disabled: native tool catalog and prompt preserved",
  );
} finally {
  await host?.close();
  await workspaceTools.close();
  await upstream.close();
  await rm(root, { recursive: true, force: true });
}
