import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadOpenCode } from "../../server/src/backends/opencode/runtime.mjs";
import { startWorkspaceTools } from "../../server/src/backends/opencode/workspace-tools.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";

const sdk = process.env.OPENCODE_SDK_ENTRY;
assert.ok(sdk, "Set OPENCODE_SDK_ENTRY to the OpenCode 2.3.2 SDK entry");
const searchMode = process.env.OPENCODE_SEARCH_FIXTURE || "default";
const searchQuery = "Isolated Node.js search";
const searchCalls = [];
const root = await mkdtemp(join(tmpdir(), "claudex-workspace-tools-"));
Object.assign(process.env, {
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_FLAGS: "full_codemode",
});
const cwd = join(root, "workspace");
await mkdir(cwd);
await writeFile(join(cwd, "alpha.txt"), "a-one\na-two\na-three\na-four\n");
await writeFile(join(cwd, "beta.txt"), "b-one\nb-two\n");
await writeFile(join(cwd, "private.txt"), "PRIVATE-FIXTURE\n");
await writeFile(
  join(cwd, "tiny.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAJ0lEQVR4nO3NsQkAAAjAsP5/tHiFgxDInmqOCQQCgUAgEAgEgifBAvzU+C6g3Kb1AAAAAElFTkSuQmCC",
    "base64",
  ),
);
const skillRoot = join(root, ".copilot", "skills");
const enabledSkills = ["fixture-planning", "fixture-writing"];
for (const id of enabledSkills) {
  const directory = join(skillRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${id}\ndescription: Instructions for ${id}\n---\n\nFixture steps for ${id}.\n`,
  );
  await writeFile(join(directory, "reference.md"), `Reference for ${id}.\n`);
}
const blocked = join(root, "blocked");
await mkdir(blocked);
await writeFile(join(blocked, "reference.md"), "EXTERNAL-DENIED-FIXTURE\n");

const html = `${"Unrelated introduction.\n".repeat(2600)}\n## Appendix\nThe actual option is FEATURE_HINT.\n`;
const requests = [];
const site = createServer((request, response) => {
  requests.push(request.url);
  const send = (content, mime = "text/markdown") =>
    response.writeHead(200, { "content-type": mime }).end(content);
  if (request.url === "/index") {
    if (request.headers.accept.startsWith("text/html"))
      return send(
        '<main><h1>Intro</h1><p>Welcome to the manual.</p></main><nav><a href="/agents">Agents</a><a href="/instructions/">Instructions</a></nav>',
        "text/html",
      );
    return send("# Intro\n\nWelcome to the manual.");
  }
  if (request.url === "/rules") {
    if (requests.filter((path) => path === "/rules").length === 1)
      return request.socket.destroy();
    return response.writeHead(301, { location: "/instructions/" }).end();
  }
  if (request.url === "/instructions/")
    return send("# Instructions\n\nProject guidance lives in AGENTS.md.");
  if (request.url === "/missing") return response.writeHead(404).end();
  send(html);
});
site.listen(0, "127.0.0.1");
await once(site, "listening");
const origin = `http://127.0.0.1:${site.address().port}`;
const steps = [
  [
    "read",
    {
      files: [
        { path: "alpha.txt", start: 1, end: 2 },
        { path: "alpha.txt", start: 2, end: 4 },
        { path: "beta.txt", start: 1, end: 1 },
        { path: join(skillRoot, enabledSkills[0], "reference.md") },
        { path: join(blocked, "reference.md") },
        { path: "." },
        { path: "tiny.png" },
      ],
    },
  ],
  ["grep", { pattern: "one", include: "*.txt" }],
  [
    "webfetch",
    { url: `${origin}/docs`, terms: ["FEATURE_HINT"], contextLines: 1 },
  ],
  [
    "patch",
    {
      patchText:
        "*** Begin Patch\n*** Add File: one.txt\n+one\n*** Add File: two.txt\n+two\n*** End Patch",
    },
  ],
  ["read", { files: [{ path: "private.txt", start: 1, end: 1 }] }],
  [
    "patch",
    {
      patchText:
        "*** Begin Patch\n*** Add File: allowed.txt\n+allowed\n*** Add File: blocked.txt\n+blocked\n*** End Patch",
    },
  ],
  ["skill", { ids: [...enabledSkills, enabledSkills[0]] }],
  ["shell", { command: "printf claudex-shell-fixture", workdir: cwd }],
  [
    "webfetch",
    { url: `${origin}/index`, terms: ["Rules", "Agents", "GitHub"] },
  ],
  [
    "webfetch",
    { url: `${origin}/rules`, terms: ["AGENTS.md", "instructions"] },
  ],
  ["webfetch", { url: `${origin}/index` }],
  ["webfetch", { url: `${origin}/missing`, terms: ["missing"] }],
  ["web_search", { query: searchQuery }],
];
let index = 0;
const seen = [];
const completed = Promise.withResolvers();
const upstream = await messagesServer((input) => {
  if (!input.tools?.length)
    return [{ type: "text", text: "Isolated tool verification" }];
  const names = input.tools.map(({ name }) => name);
  if (!names.includes("claudex_read")) {
    completed.reject(
      new Error(`Missing replacement tools. Exposed: ${names.join(", ")}`),
    );
    return [{ type: "text", text: "Replacement tools unavailable" }];
  }
  seen.push(input);
  const step = steps[index++];
  if (!step) {
    completed.resolve();
    return [{ type: "text", text: "Complete" }];
  }
  return [
    {
      type: "tool_use",
      id: `toolu_workspace_${index}`,
      name: `claudex_${step[0]}`,
      input: step[1],
    },
  ];
});
const startup = await startWorkspaceTools();
let host;
try {
  const OpenCode = await loadOpenCode(resolve(sdk), { workspaceTools: true });
  host = await OpenCode.create({
    database: { path: join(root, "opencode.db") },
    config: {
      directory: join(root, "config"),
      project: false,
      claude: false,
      content: JSON.stringify({
        skills: { paths: [skillRoot] },
        ...(searchMode === "disabled" && { websearch: false }),
        ...(["configured", "failure"].includes(searchMode) && {
          websearch: { provider: "fixture-search" },
        }),
        providers: {
          fixture: {
            package: "@ai-sdk/anthropic",
            settings: { baseURL: `${upstream.url}/v1`, apiKey: "fixture" },
            models: { "claude-sonnet-4-6": { name: "Fixture" } },
          },
        },
      }),
    },
    models: { fetch: false },
    fs: { filewatcher: false },
    plugins: [
      {
        id: "fixture.websearch",
        setup(ctx) {
          return ctx.websearch.transform((editor) => {
            for (const id of ["exa", "fixture-search"])
              editor.add({
                id,
                name: id,
                async execute({ query }) {
                  searchCalls.push({ id, query });
                  if (searchMode === "failure")
                    throw new Error("Fixture provider failed");
                  return [
                    {
                      url: "https://nodejs.org/en/about/previous-releases",
                      title: id,
                      content: "Release evidence",
                      time: {},
                    },
                  ];
                },
              });
          });
        },
      },
      startup.plugin,
    ],
  });
  const session = await host.sessions.create({
    location: { directory: cwd },
    model: { providerID: "fixture", id: "claude-sonnet-4-6" },
    title: "Isolated workspace tools",
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "private.txt", effect: "deny" },
      { action: "edit", resource: "blocked.txt", effect: "deny" },
      {
        action: "external_directory",
        resource: join(blocked, "*"),
        effect: "deny",
      },
    ],
  });
  const timer = setTimeout(
    () => completed.reject(new Error("Native tool verification timed out")),
    20_000,
  );
  try {
    await host.sessions.prompt({
      sessionID: session.id,
      text: "Run the fixture.",
    });
    await completed.promise;
  } finally {
    clearTimeout(timer);
  }
  const advertised = seen[0].tools.map(({ name }) => name);
  for (const name of [
    "read",
    "grep",
    "webfetch",
    "websearch",
    "patch",
    "edit",
    "write",
    "skill",
    "shell",
  ])
    assert.ok(!advertised.includes(name), name);
  for (const name of [
    "read",
    "grep",
    "webfetch",
    "web_search",
    "patch",
    "skill",
    "shell",
  ])
    assert.ok(advertised.includes(`claudex_${name}`), name);
  const results = seen
    .at(-1)
    .messages.flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .filter(({ type }) => type === "tool_result");
  const result = (i) =>
    results.find(({ tool_use_id }) => tool_use_id === `toolu_workspace_${i}`);
  assert.match(JSON.stringify(result(1)), /alpha.txt:1-4/);
  assert.match(JSON.stringify(result(1)), /beta.txt:1-1/);
  assert.match(JSON.stringify(result(1)), /Reference for fixture-planning/);
  assert.doesNotMatch(JSON.stringify(result(1)), /EXTERNAL-DENIED-FIXTURE/);
  assert.match(JSON.stringify(result(1)), /Read directory/);
  assert.match(JSON.stringify(result(1)), /image\/(?:png|jpeg)/);
  assert.match(JSON.stringify(result(2)), /alpha.txt/);
  assert.doesNotMatch(JSON.stringify(result(2)), /a-one/);
  assert.match(JSON.stringify(result(3)), /actual option is FEATURE_HINT/);
  assert.doesNotMatch(JSON.stringify(result(3)), /Unrelated introduction/);
  assert.equal(await readFile(join(cwd, "one.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(cwd, "two.txt"), "utf8"), "two\n");
  assert.equal(result(5).is_error, true);
  assert.doesNotMatch(JSON.stringify(result(5)), /PRIVATE-FIXTURE/);
  assert.equal(result(6).is_error, true);
  await assert.rejects(readFile(join(cwd, "allowed.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(cwd, "blocked.txt")), { code: "ENOENT" });
  const skills = JSON.stringify(result(7));
  assert.equal(skills.match(/Fixture steps for fixture-planning/g)?.length, 1);
  assert.match(skills, /Fixture steps for fixture-writing/);
  assert.match(JSON.stringify(result(8)), /claudex-shell-fixture/);
  assert.match(JSON.stringify(result(9)), /Welcome to the manual/);
  assert.match(
    JSON.stringify(result(9)),
    /Page links[\s\S]*Agents[\s\S]*\/agents/,
  );
  assert.match(
    JSON.stringify(result(9)),
    /Instructions[\s\S]*\/instructions\//,
  );
  assert.match(
    JSON.stringify(result(10)),
    /Project guidance lives in AGENTS\.md/,
  );
  assert.equal(requests.filter((path) => path === "/rules").length, 2);
  assert.equal(requests.filter((path) => path === "/instructions/").length, 1);
  const webTool = seen[0].tools.find(({ name }) => name === "claudex_webfetch");
  assert.deepEqual(webTool.input_schema.required, ["url"]);
  assert.match(
    JSON.stringify(result(11)),
    /Welcome to the manual[\s\S]*Page links/,
  );
  assert.equal(result(12).is_error, true);
  assert.equal(requests.filter((path) => path === "/missing").length, 1);
  if (searchMode === "disabled") {
    assert.deepEqual(searchCalls, []);
    assert.equal(result(13).is_error, true);
  } else {
    const id = searchMode === "default" ? "exa" : "fixture-search";
    assert.deepEqual(searchCalls, [{ id, query: searchQuery }]);
    if (searchMode === "failure") assert.equal(result(13).is_error, true);
    else
      assert.match(JSON.stringify(result(13)), /nodejs\.org.*Release evidence/);
  }
  console.log(
    `OpenCode web search ${searchMode}: ${searchCalls.map(({ id }) => id).join(", ") || "no provider called"}`,
  );
  console.log(
    "OpenCode SDK 2.3.2: claudex_ tool replacements, external reads, directory and image, batched skills, patch, shell, grep, web and native permission rules passed.",
  );
} finally {
  await host?.close();
  await startup.close();
  await upstream.close();
  site.closeAllConnections();
  await new Promise((done) => site.close(done));
  await rm(root, { recursive: true, force: true });
}
