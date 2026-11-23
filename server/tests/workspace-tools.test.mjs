import assert from "node:assert/strict";
import test from "node:test";
import { formatReadRange, readRanges } from "../src/workspace/tools/ranges.mjs";
import { applyWorkspaceToolGuidance } from "../src/backends/opencode/workspace-tool-guidance.mjs";
import {
  pageEvidence,
  searchSummary,
} from "../src/workspace/tools/evidence.mjs";

test("batch reads merge aliases, adjacent and overlapping ranges before reading", async () => {
  const reads = [];
  const rows = await readRanges(
    "/sample/workspace",
    {
      files: [
        { path: "src/a.js", start: 4, end: 4 },
        { path: "./src/a.js", start: 2, end: 3 },
        { path: "src/a.js", start: 3, end: 5 },
        { path: "test/a.test.js", start: 8, end: 8 },
      ],
    },
    async (range) => {
      reads.push(range);
      return {
        text: formatReadRange(
          range.path,
          range.start,
          Array.from({ length: range.end - range.start + 1 }, () => "text"),
        ),
      };
    },
  );
  assert.deepEqual(reads, [
    { path: "src/a.js", start: 2, end: 5 },
    { path: "test/a.test.js", start: 8, end: 8 },
  ]);
  assert.match(rows[0].text, /src\/a\.js:2-5\ntext\ntext\ntext\ntext/);
  assert.match(rows[1].text, /test\/a\.test\.js:8-8/);
});

test("an invalid batch does not start reading its earlier files", async () => {
  await assert.rejects(
    readRanges(
      "/sample/workspace",
      {
        files: [
          { path: "inside.txt", start: 1, end: 2 },
          { path: "../outside.txt", start: 2, end: 1 },
        ],
      },
      () => assert.fail("read was called for an invalid batch"),
    ),
    /Invalid line range/,
  );
});

test("absolute, external, home and virtual skill paths reach the native reader", async () => {
  const paths = [
    "/sample/agent/skill.md",
    "../agent/other.md",
    "~/skill.md",
    "skill://sample/ref.md",
    ".",
  ];
  const rows = await readRanges(
    "/sample/workspace",
    { files: paths.map((path) => ({ path })) },
    async ({ path, start, end }) => {
      assert.equal(start, 1);
      assert.equal(end, Infinity);
      if (path === "~/skill.md") throw new Error("native deny");
      return { text: path };
    },
  );
  assert.deepEqual(
    rows.map(({ text }) => text),
    paths.map((path) =>
      path === "~/skill.md" ? "~/skill.md: native deny" : path,
    ),
  );
});

test("web evidence matches text past the prefix and merges overlapping excerpts", () => {
  const page = [
    ...Array.from({ length: 1000 }, () => "Unrelated content"),
    "Neighbor",
    "a feature",
    "the feature limit",
    "End",
  ].join("\n");
  const result = pageEvidence(page, {
    url: "https://example.test/manual",
    terms: ["FEATURE"],
    contextLines: 1,
  });
  assert.match(result, /^https:\/\/example\.test\/manual\n\nLines 1001-1004/);
  assert.doesNotMatch(result, /Unrelated/);
  assert.equal(result.match(/Lines /g).length, 1);
});

test("compact search distinguishes incomplete counts and never returns lines in path mode", () => {
  const matches = {
    output: [
      { entry: { path: "alpha.txt" }, line: 4, text: "source line" },
      { entry: { path: "alpha.txt" }, line: 7, text: "another line" },
    ],
    metadata: { truncated: true },
  };
  assert.match(
    searchSummary(matches, "count"),
    /^alpha\.txt: 2\n\[Result limited/,
  );
  assert.match(
    searchSummary(matches, "files"),
    /^alpha\.txt\n\[Result limited/,
  );
  assert.doesNotMatch(searchSummary(matches, "files"), /source line/);
});

test("optimized prompt replaces complete native paragraphs and keeps project and skill data", async () => {
  const unrelated = "Keep the imported project instructions.";
  const catalog =
    "<available_skills>\n  <skill>fixture</skill>\n</available_skills>";
  const oldSkillBlock =
    "A newly worded upstream instruction to call skill.\n" + catalog;
  const skillKey = "core/skill-guidance";
  const system = [
    {
      type: "text",
      text: "# Tone\nKeep answers short.\n\nA future template tells the model to use `read`. This entire paragraph must go.",
    },
    {
      type: "text",
      text: oldSkillBlock + "\n\n" + unrelated,
      metadata: {
        experimental: {
          instructions: [
            { key: skillKey, text: oldSkillBlock },
            { key: "fixture/project", text: unrelated },
          ],
        },
      },
    },
  ];
  const messages = [
    {
      role: "system",
      metadata: { instructionSources: ["fixture/project", skillKey] },
      content: [{ type: "text", text: unrelated + "\n\n" + oldSkillBlock }],
    },
    { role: "user", content: [{ type: "text", text: oldSkillBlock }] },
  ];
  await applyWorkspaceToolGuidance(
    {
      agent: "build",
      tools: { claudex_read: {}, claudex_skill: {} },
      system,
      messages,
    },
    async () => ({}),
  );
  assert.equal(system[0].text, "# Tone\nKeep answers short.");
  assert.match(
    system[1].text,
    /^# Workspace tools[\s\S]*Use `claudex_read`[\s\S]*Use `claudex_skill`/,
  );
  assert.equal(system[2].text, catalog + "\n\n" + unrelated);
  assert.equal(system[2].metadata.experimental.instructions[0].text, catalog);
  assert.equal(messages[0].content[0].text, unrelated + "\n\n" + catalog);
  assert.equal(messages[1].content[0].text, oldSkillBlock);
});
