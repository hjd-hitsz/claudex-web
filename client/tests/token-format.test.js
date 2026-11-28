import assert from "node:assert/strict";
import test from "node:test";
import { formatTokenCount } from "../src/domain/token-format.js";

test("三端上下文摘要与展开明细共用千位和百万格式", () => {
  assert.deepEqual(
    [0, 999, 1000, 1049, 1050, 999999, 1048576, 1000000, 1234567].map(
      formatTokenCount,
    ),
    ["0", "999", "1K", "1K", "1.1K", "1M", "1M", "1M", "1.2M"],
  );
});

test("千位四舍五入进位到 1M", () => {
  const values = [999499, 999500, 999949, 999950, 999999, 1000000, 1048576];
  assert.deepEqual(values.map(formatTokenCount), [
    "999.5K",
    "999.5K",
    "999.9K",
    "1M",
    "1M",
    "1M",
    "1M",
  ]);
  const nearMillion = Array.from(
    { length: 1001 },
    (_, index) => 999000 + index,
  );
  assert.equal(nearMillion.map(formatTokenCount).includes("1000K"), false);
});
