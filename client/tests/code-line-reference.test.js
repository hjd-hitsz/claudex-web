import assert from "node:assert/strict";
import test from "node:test";
import {
  codeLineAttachment,
  codeLineContext,
  sameDraftText,
} from "../src/domain/code-line-reference.js";
import { parseUserMessage } from "../src/domain/user-message.js";
import { attachmentInputs } from "../src/application/attachments.js";

test("代码行候选以独立文本附件发送并从历史恢复", async () => {
  const code = "    result = inputs[0] + 1";
  const matches = [
    { path: "/project/a #1.py", line: 3 },
    { path: '/project/b "final":revision.py', line: 15 },
  ];
  const attachment = codeLineAttachment(code, matches);
  const [input] = await attachmentInputs([attachment], () =>
    assert.fail("文件候选无需上传"),
  );
  assert.equal(input.type, "text");
  assert(
    input.text.startsWith(
      "\n\n同一段粘贴代码匹配到多处。需要源码上下文时，请直接读取以下候选位置并核对。\n" +
        '- /project/a #1.py:3\n- /project/b "final":revision.py:15\n\n',
    ),
  );
  assert(input.text.endsWith("\n\n"));
  const restored = parseUserMessage([
    { type: "text", text: "请检查这里" },
    input,
  ]);
  assert.equal(restored.text, "请检查这里");
  assert.deepEqual(restored.codeAttachments[0].matches, matches);
  assert.deepEqual(restored.codeAttachments[0].input, input);
  assert.equal(codeLineAttachment(code, [...matches, ...matches]), null);
});

test("旧历史中的代码来源可以编辑并以明确的路径和行号重发", () => {
  const code = "class Costs:";
  const matches = [{ path: "/project/costs.py", line: 4 }];
  const anchors = [crypto.randomUUID()];
  const { codeAttachments } = parseUserMessage([
    {
      type: "text",
      text:
        "粘贴代码的匹配文件候选：\n" +
        JSON.stringify({ code, matches, anchors }),
    },
  ]);
  const [source] = codeAttachments;
  assert.deepEqual(source.anchors, anchors);
  assert.deepEqual(source.matches, matches);
  assert.equal(
    codeLineContext(source),
    "粘贴代码已定位。需要源码上下文时，请直接读取以下绝对路径和行号。\n- /project/costs.py:4",
  );
  assert(source.input.text.includes(codeLineContext(source)));
});

test("历史中来源相同的附件合并，保留全部正文位置", () => {
  const code = "class Costs:";
  const matches = [{ path: "/project/costs.py", line: 4 }];
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const { codeAttachments } = parseUserMessage([
    codeLineAttachment(code, matches, "first", [first]).input,
    codeLineAttachment(code, matches, "second", [second]).input,
  ]);
  assert.equal(codeAttachments.length, 1);
  assert.deepEqual(codeAttachments[0].anchors, [first, second]);
});

test("发送期间生成源码标记时仍识别原草稿，并保留真正的正文修改", () => {
  const anchor = crypto.randomUUID();
  const inline = "`class Costs:`";
  const inlineWithSource = `${inline}<!--claudex-code-source:${anchor}-->`;
  const fenced = "```python claudex-paste before after";
  const body = "\nclass Costs:\n    pass\n```";
  assert(sameDraftText(inlineWithSource, inline));
  assert(sameDraftText(`${fenced} source=${anchor}${body}`, fenced + body));
  assert(!sameDraftText(inlineWithSource + " 请再检查", inline));
  assert(!sameDraftText(null, inline));
});
