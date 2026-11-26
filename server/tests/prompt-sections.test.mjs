import assert from "node:assert/strict";
import test from "node:test";
import { promptSections } from "../../shared/prompt-sections.mjs";

test("按带标识的 Markdown 标题提取正文并保留内部格式", () => {
  const body = [
    '使用 "引号"、{{id}} 和 <文件>。',
    "",
    "## 正文中的标题",
    "",
    "    保留缩进",
  ].join("\n");
  const markdown = [
    "# 提示词文件",
    "",
    "维护说明",
    "",
    "## 请求 <!-- prompt: request -->",
    "",
    body,
    "",
    "## 回复 <!-- prompt: reply -->",
    "",
    "回复正文",
    "",
  ].join("\r\n");
  const section = promptSections(markdown, "fixture.md");
  assert.equal(section("request"), body);
  assert.equal(section("reply"), "回复正文");
  assert.throws(() => section("missing"), /fixture\.md #missing/);
});

test("空段落和重复标识包含明确的文件位置", () => {
  const heading = "## 请求 <!-- prompt: request -->";
  for (const markdown of [
    heading + "\n\n",
    heading + "\n正文一\n\n" + heading + "\n正文二\n",
  ])
    assert.throws(
      () => promptSections(markdown, "fixture.md"),
      /fixture\.md #request/,
    );
});
