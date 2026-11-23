import assert from "node:assert/strict";
import test from "node:test";
import { codeLineAttachment } from "../src/domain/code-line-reference.js";
import { parseUserMessage } from "../src/domain/user-message.js";
import { attachmentInputs } from "../src/application/attachments.js";

test("代码行候选以独立文本附件发送并从历史恢复", async () => {
  const code = "    result = inputs[0] + 1";
  const matches = [
    { path: "/project/a #1.py", line: 3 },
    { path: '/project/b "final".py', line: 15 },
  ];
  const attachment = codeLineAttachment(code, matches);
  const [input] = await attachmentInputs([attachment], () =>
    assert.fail("文件候选无需上传"),
  );
  assert.equal(input.type, "text");
  assert(input.text.includes("inputs[0]"));
  const restored = parseUserMessage([
    { type: "text", text: "请检查这里" },
    input,
  ]);
  assert.equal(restored.text, "请检查这里");
  assert.deepEqual(restored.codeAttachments[0].matches, matches);
  assert.deepEqual(restored.codeAttachments[0].input, input);
  assert.equal(codeLineAttachment(code, [...matches, ...matches]), null);
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
