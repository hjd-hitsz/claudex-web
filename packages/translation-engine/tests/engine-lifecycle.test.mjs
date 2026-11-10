import test from "node:test";
import assert from "node:assert/strict";
import { createTranslationEngine } from "../src/index.mjs";

test(
  "引擎按需启动，未准备与准备失败均能关闭并结束进程",
  { timeout: 10000 },
  async () => {
    const unused = createTranslationEngine({ directory: "/dev/null/models" });
    await unused.close();
    await unused.close();
    await assert.rejects(unused.prepare(), /关闭/);
    const engine = createTranslationEngine({ directory: "/dev/null/models" });
    try {
      await assert.rejects(engine.translate(["English input"]), /尚未就绪/);
      await assert.rejects(engine.prepare(), /ENOTDIR/);
    } finally {
      await engine.close();
      await engine.close();
    }
  },
);
