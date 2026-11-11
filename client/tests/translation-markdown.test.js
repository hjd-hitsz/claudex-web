import test from "node:test";
import assert from "node:assert/strict";
import { translateSummaries } from "../src/infrastructure/summary-translator.js";

test("完整 Markdown 消息只发送正文文本，保留强调、代码、链接、列表与已有中文", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/translate");
    const { texts } = JSON.parse(options.body);
    seen.push(...texts);
    return Response.json({
      translations: texts.map((text) =>
        text
          .replace("Inspecting history dump", "检查历史转储")
          .replace("Read ", "阅读 ")
          .replace(" and keep ", "并保留 ")
          .replace("Visit docs", "查看文档"),
      ),
    });
  });
  const source =
    "**Inspecting history dump**\n\nRead `behavior.md` and keep **emitState()**.\n\n- [Visit docs](https://example.org/docs)\n\n```js\nconst literal = 'English code';\n```\n\n已有中文";
  const [result] = await translateSummaries([source]);
  assert.ok(seen.includes("Inspecting history dump"));
  assert.ok(seen.every((text) => !/\*\*|`|https:|English code/.test(text)));
  assert.match(result, /\*\*检查历史转储\*\*/);
  assert.match(result, /`behavior.md`/);
  assert.match(result, /\[查看文档\]\(https:\/\/example.org\/docs\)/);
  assert.ok(result.includes("const literal = 'English code';"));
  assert.ok(result.endsWith("已有中文"));
});

test("长消息保留完整文本节点，完整返回后按原位置恢复格式", async (t) => {
  const sentence = "Inspect the stored conversation and preserve its content. ";
  const source = `# Summary\n\n${sentence.repeat(70)}\n\nRead \`config.model\`.`;
  const batches = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const { texts } = JSON.parse(options.body);
    batches.push(texts);
    return Response.json({
      translations: texts.map((text) =>
        text.replaceAll(sentence, "检查已保存对话并保留其内容。"),
      ),
    });
  });
  const [result] = await translateSummaries([source]);
  assert.ok(batches.flat().includes(sentence.repeat(70).trimEnd()));
  assert.ok(result.startsWith("# Summary\n\n检查已保存对话"));
  assert.ok(result.endsWith("Read `config.model`."));
});

test("模型失败及不完整响应保留重试错误，纯代码和中文不产生请求", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ translations: [] }),
  );
  assert.deepEqual(await translateSummaries(["`git status`", "已有中文"]), [
    "`git status`",
    "已有中文",
  ]);
  assert.equal(mock.mock.callCount(), 0);
  await assert.rejects(translateSummaries(["Checking files"]), /不完整/);
  mock.mock.mockImplementation(async () =>
    Response.json({ error: "模型尚未就绪" }, { status: 503 }),
  );
  await assert.rejects(translateSummaries(["Checking files"]), /模型尚未就绪/);
});
