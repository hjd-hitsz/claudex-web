import test from "node:test";
import assert from "node:assert/strict";
import { delimiter, dirname } from "node:path";
import { nativeCliDependency } from "../src/backends/cli-package.mjs";
import { createCliInstallation } from "../src/backends/cli-installation.mjs";

test("平台依赖按上游清单选择 Codex 别名及 Claude glibc、musl、ARM 包", () => {
  for (const [id, platform, arch, libc, name, spec] of [
    [
      "codex",
      "linux",
      "x64",
      "glibc",
      "@openai/codex-linux-x64",
      "npm:@openai/codex@1.2.3-linux-x64",
    ],
    [
      "codex",
      "darwin",
      "arm64",
      "glibc",
      "@openai/codex-darwin-arm64",
      "npm:@openai/codex@1.2.3-darwin-arm64",
    ],
    [
      "claude",
      "linux",
      "arm64",
      "musl",
      "@anthropic-ai/claude-code-linux-arm64-musl",
      "2.1.0",
    ],
    [
      "claude",
      "linux",
      "x64",
      "glibc",
      "@anthropic-ai/claude-code-linux-x64",
      "2.1.0",
    ],
  ]) {
    assert.equal(
      nativeCliDependency(
        id,
        { optionalDependencies: { [name]: spec } },
        platform,
        arch,
        libc,
      ),
      `${name}@${spec}`,
    );
  }
  assert.equal(nativeCliDependency("claude", { version: "1.0.0" }), null);
  assert.throws(
    () =>
      nativeCliDependency(
        "codex",
        { optionalDependencies: { "@openai/codex-linux-x64": "1.0.0" } },
        "linux",
        "arm64",
        "glibc",
      ),
    /未提供 linux\/arm64/,
  );
});

test("原生包下载失败保留当前版本，重试先完成下载再安装并校验", async () => {
  const manifest = {
    version: "1.2.3",
    optionalDependencies: {
      [`@openai/codex-${process.platform}-${process.arch}`]:
        "npm:@openai/codex@1.2.3-native",
    },
  };
  const calls = [];
  let failDownload = true,
    installed = false;
  const run = async (command, args, options) => {
    calls.push(args);
    assert.equal(
      options.env.PATH.split(delimiter)[0],
      dirname(process.execPath),
    );
    if (args[0] === "view") return { stdout: JSON.stringify(manifest) };
    if (args.includes("--prefix") && failDownload)
      throw Object.assign(new Error("download aborted"), {
        stderr: "npm error code ECONNRESET\nnpm error network aborted",
      });
    if (args.includes("--global")) installed = true;
    return { stdout: installed ? "codex-cli 1.2.3" : "codex-cli 1.2.2" };
  };
  const cli = createCliInstallation({
    run,
    locate: async () => "/fixture/codex",
    fetchVersion: async () => "1.2.3",
  });
  await cli.refresh("codex");
  calls.length = 0;
  await assert.rejects(cli.install("codex"), /原生组件下载失败/);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["view", "install"],
  );
  assert.equal(cli.state("codex").currentVersion, "1.2.2");
  assert.equal(cli.state("codex").installed, true);
  assert.equal(cli.state("codex").installing, false);
  assert.match(cli.state("codex").installErrorDetails, /ECONNRESET/);
  failDownload = false;
  calls.length = 0;
  await cli.install("codex");
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["view", "install", "install", "--version"],
  );
  assert.equal(cli.state("codex").currentVersion, "1.2.3");
  assert.equal(cli.state("codex").installErrorDetails, "");
});

test("npm 返回成功但 CLI 缺失原生文件时提供简短错误与完整诊断", async () => {
  const cli = createCliInstallation({
    locate: async () => "/fixture/codex",
    fetchVersion: async () => "1.2.3",
    run: async (command, args) => {
      if (args[0] === "view") return { stdout: '{"version":"1.2.3"}' };
      if (args[0] === "--version")
        throw Object.assign(
          new Error("Command failed: /fixture/codex --version"),
          {
            stderr:
              "Error: Missing optional dependency\n    at findCodexExecutable (file:///fixture/bin/codex.js:20)",
          },
        );
      return { stdout: "" };
    },
  });
  await assert.rejects(cli.install("codex"), /CLI 校验失败/);
  assert.equal(cli.state("codex").installed, false);
  assert.equal(cli.state("codex").executable, null);
  assert.ok(!cli.state("codex").error.includes("findCodexExecutable"));
  assert.match(cli.state("codex").errorDetails, /findCodexExecutable/);
  assert.match(cli.state("codex").installErrorDetails, /findCodexExecutable/);
});

test("安装元数据和实际 CLI 版本必须一致", async () => {
  const cli = createCliInstallation({
    locate: async () => "/fixture/codex",
    fetchVersion: async () => "1.2.3",
    run: async (command, args) => ({
      stdout: args[0] === "view" ? '{"version":"1.2.3"}' : "codex-cli 1.2.2",
    }),
  });
  await assert.rejects(cli.install("codex"), /版本不一致/);
  assert.match(cli.state("codex").installErrorDetails, /实际版本 1.2.2/);
});
