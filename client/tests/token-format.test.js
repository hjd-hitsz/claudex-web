import assert from "node:assert/strict";
import test from "node:test";
import { formatTokenCount } from "../src/domain/token-format.js";

test("三端上下文摘要与展开明细共用千位格式", () => {
  assert.deepEqual([0, 999, 1000, 1049, 1050, 1234567].map(formatTokenCount), [
    "0",
    "999",
    "1K",
    "1K",
    "1.1K",
    "1234.6K",
  ]);
});
