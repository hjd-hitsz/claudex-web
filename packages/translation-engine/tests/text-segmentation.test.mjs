import test from "node:test";
import assert from "node:assert/strict";
import { EdgeTranslation } from "../src/inference.mjs";

test("长消息分句保留空白与 Unicode 字符完整性", async () => {
  const engine = new EdgeTranslation();
  const segments = [];
  engine.generation = { model: { context_length: 200 } };
  engine.encode = async (text) => Array.from(text);
  engine.translateSegment = async (text) => {
    assert.equal(text.isWellFormed(), true);
    segments.push(text);
    return { text };
  };
  const source = "\n  x" + "😀".repeat(300) + "\n\n";
  assert.equal((await engine.translate(source)).text, source);
  assert.ok(segments.length > 1);
  assert.ok(segments.every((text) => Array.from(text).length <= 200));
});
