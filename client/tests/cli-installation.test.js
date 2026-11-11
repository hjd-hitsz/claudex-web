import test from "node:test";
import assert from "node:assert/strict";
import { cliUpdateAvailable } from "../src/domain/cli-installation.js";

test("CLI 更新入口根据完整版本顺序显示，覆盖已更新及预发布安装", () => {
  for (const [current, latest, available] of [
    ["0.167.0", "0.168.0", true],
    ["2.1.318", "2.1.319", true],
    ["2.1.319", "2.1.319", false],
    ["0.168.0", "0.167.0", false],
    ["1.0.0-rc.2", "1.0.0", true],
    ["1.0.0", "1.0.0-rc.2", false],
    ["1.0.0-rc.2", "1.0.0-rc.10", true],
    ["1.0.0+build.1", "1.0.0+build.2", false],
    ["", "1.0.0", false],
    ["1.0.0", "", false],
  ])
    assert.equal(
      cliUpdateAvailable(current, latest),
      available,
      `${current} → ${latest}`,
    );
});
