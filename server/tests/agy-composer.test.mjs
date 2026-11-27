import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  acpCommands,
  waitForAcpCommands,
} from "../src/backends/agy/acp-events.mjs";
import {
  agyPromptBlocks,
  compileAgyPrompt,
} from "../src/backends/agy/acp-prompt.mjs";
import { projectSkills } from "../src/backends/agy/tmp_function/project-skills.mjs";
import { readAcpCatalogue } from "../src/backends/agy/model-catalogue.mjs";

test("ACP holds the latest command catalogue, preserving hints and deduplicating names", () => {
  assert.deepEqual(
    acpCommands({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "learn", description: "Learn", input: { hint: "topic" } },
        { name: "LEARN", description: "Duplicate" },
      ],
    }),
    [{ name: "learn", description: "Learn", argumentHint: "topic" }],
  );
  assert.deepEqual(
    acpCommands({
      sessionUpdate: "available_commands_update",
      availableCommands: [],
    }),
    [],
  );
  assert.equal(acpCommands({ sessionUpdate: "usage_update" }), undefined);
});

test("the new-chat catalogue waits for a command update after session/new", async () => {
  const ready = Promise.withResolvers();
  const methods = [];
  const client = {
    async call(method) {
      methods.push(method);
      if (method === "session/new") {
        setImmediate(() => {
          methods.push("available_commands_update");
          ready.resolve();
        });
        return { sessionId: "fixture" };
      }
    },
  };
  await readAcpCatalogue(
    client,
    async () => {},
    "/project",
    async () => "",
    () => waitForAcpCommands(ready.promise),
  );
  assert.deepEqual(methods, [
    "session/new",
    "available_commands_update",
    "session/close",
  ]);
});

test("agy sends actual attachment bytes and explicit project skill content in ACP resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agy-composer-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const skillDir = join(cwd, ".agents", "skills", "project-proof");
  const attachmentDir = join(root, "attachments", "upload");
  await Promise.all(
    [skillDir, attachmentDir].map((dir) => mkdir(dir, { recursive: true })),
  );
  const skillPath = join(skillDir, "SKILL.md");
  const textPath = join(attachmentDir, "样本 #1.txt");
  const binaryPath = join(attachmentDir, "样本.bin");
  const body = "实际附件正文\n第二行\n";
  const skillText =
    "---\nname: project-proof\ndescription: 项目验收\n---\n\nSKILL_PAYLOAD";
  await Promise.all([
    writeFile(skillPath, skillText),
    writeFile(textPath, body),
    writeFile(binaryPath, Uint8Array.of(0, 42, 255)),
  ]);
  assert.deepEqual(await projectSkills(cwd), [
    {
      name: "project-proof",
      description: "项目验收",
      path: skillPath,
      text: skillText,
    },
  ]);
  const options = {
    cwd,
    configDir: root,
    capabilities: { embeddedContext: true },
  };
  const selected = { type: "skill", name: "project-proof", path: skillPath };
  const file = { type: "file", name: "样本 #1.txt", path: textPath };
  const image = { type: "image", url: "data:image/png;base64,YQ==" };
  const blocks = await agyPromptBlocks(
    [
      { type: "text", text: "代码位置：src/main.js:12" },
      file,
      { type: "file", name: "样本.bin", path: binaryPath },
      image,
      selected,
      selected,
    ],
    options,
  );
  assert.deepEqual(blocks[0], {
    type: "text",
    text: "代码位置：src/main.js:12",
  });
  assert.deepEqual(blocks[1], {
    type: "resource",
    resource: {
      uri: pathToFileURL(textPath).href,
      mimeType: "text/plain",
      text: body,
    },
  });
  assert.equal(blocks[2].type, "resource");
  assert.match(
    blocks[2].resource.text,
    /application\/octet-stream[\s\S]*ACr\//,
  );
  assert.deepEqual(blocks[3], {
    type: "image",
    mimeType: "image/png",
    data: "YQ==",
  });
  assert.equal(blocks[4].resource.uri, pathToFileURL(skillPath).href);
  assert(blocks[4].resource.text.includes(skillText));
  assert.equal(blocks.length, 5);
  await assert.rejects(
    agyPromptBlocks([file], { ...options, capabilities: {} }),
    /不支持内嵌/,
  );
  await assert.rejects(
    agyPromptBlocks([{ ...file, path: skillPath }], options),
    /无法读取附件/,
  );
  await rm(skillPath);
  await assert.rejects(
    agyPromptBlocks([selected], options),
    /已移动、删除或改名/,
  );
});

test("native slash command stays first when applying saved context and user resources", async () => {
  const command = { type: "text", text: "/grill-me project scope" };
  const file = {
    type: "resource",
    resource: { uri: "file:///proof.txt", text: "Proof" },
  };
  const session = {
    id: "session",
    nativeContextPending: true,
    turns: [
      { id: "saved", items: [{ type: "agentMessage", text: "已保存上下文" }] },
    ],
  };
  const { promptBlocks } = await compileAgyPrompt(
    session,
    [command, file],
    { input: { userInput: true, nativeCommand: "grill-me" } },
    false,
    { forwardingContext: (_id, blocks) => blocks },
  );
  assert.deepEqual(promptBlocks[0], {
    ...command,
    text: command.text + "\n\n",
  });
  assert.match(promptBlocks[1].text, /已保存上下文/);
  assert.equal(promptBlocks[2], file);
});
