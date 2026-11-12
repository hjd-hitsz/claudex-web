import { delimiter, dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

export function cliEnvironment() {
  return {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}`,
  };
}

export function cliFailure(message, cause) {
  const error = new Error(message, { cause });
  error.details =
    cause.details ||
    [cause.stderr, cause.stdout, cause.message]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .join("\n");
  return error;
}

export function nativeCliDependency(
  id,
  manifest,
  platform = process.platform,
  arch = process.arch,
  libc,
) {
  const dependencies = manifest.optionalDependencies || {};
  if (!Object.keys(dependencies).length) return null;
  const prefix = id === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  const suffix =
    id === "claude" &&
    platform === "linux" &&
    (libc
      ? libc === "musl"
      : !process.report.getReport().header.glibcVersionRuntime)
      ? "-musl"
      : "";
  const name = `${prefix}-${platform}-${arch}${suffix}`;
  if (!dependencies[name])
    throw new Error(`安装包未提供 ${platform}/${arch} 的原生组件。`);
  return `${name}@${dependencies[name]}`;
}

export async function installCliPackage(id, packageName, run) {
  const name = id === "codex" ? "Codex" : "Claude Code";
  const npm = join(dirname(process.execPath), "npm");
  const options = {
    timeout: 20 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: cliEnvironment(),
  };
  let manifest;
  try {
    const { stdout } = await run(
      npm,
      ["view", `${packageName}@latest`, "--json"],
      options,
    );
    manifest = JSON.parse(stdout);
    if (typeof manifest.version !== "string")
      throw new Error("npm 安装信息缺少版本号。");
  } catch (error) {
    throw cliFailure(
      `读取 ${name} 安装信息失败，请查看错误详情后重试。`,
      error,
    );
  }
  const native = nativeCliDependency(id, manifest);
  if (native) {
    const directory = await mkdtemp(join(tmpdir(), "claudex-cli-native-"));
    try {
      // 平台二进制虽由上游声明为 optional，完整下载是 CLI 可用的前提。
      await run(
        npm,
        [
          "install",
          "--prefix",
          directory,
          "--no-save",
          "--package-lock=false",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          native,
        ],
        options,
      );
    } catch (error) {
      throw cliFailure(
        `${name} 原生组件下载失败，请检查服务器网络或代理后重试。`,
        error,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    await run(
      npm,
      [
        "install",
        "--global",
        "--include=optional",
        "--ignore-scripts=false",
        `${packageName}@${manifest.version}`,
      ],
      options,
    );
  } catch (error) {
    throw cliFailure(`${name} 安装失败，请查看错误详情后重试。`, error);
  }
  return manifest.version;
}
