// ACP 缺口。embeddedContext 的 resource.text 可进入模型，resource.blob 会被跳过。
// 秘书代理隔离工作区定制后，available_commands_update 省略项目技能，ACP 缺少项目技能列举方法。
// 探测证据。agy 1.5.18 的 session/prompt 接受 resource.blob，隔离 Gemini 请求只收到 resource.text。
// 同版本的 skills/list 和 session/skills/list 返回 -32601 Method not found。
// 切换条件。复验 Gemini 请求携带 blob 原始字节和媒体类型，并验证 ACP 在保持定制隔离时能列举和显式调用秘书项目技能。
// 见 docs/future_plan.md#缺口登记中的「项目技能与原生斜杠命令」和「普通文件内嵌资源」。
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeTextFile,
  filePresentation,
} from "../../../../../shared/file-types.mjs";
import { acpContent } from "../acp-events.mjs";
import { embedBinaryResource } from "./binary-resource.mjs";
import { selectedSkill } from "./project-skills.mjs";

function resource(path, mimeType, text) {
  return {
    type: "resource",
    resource: { uri: pathToFileURL(path).href, mimeType, text },
  };
}

async function attachment(part, configDir) {
  try {
    const root = await realpath(join(configDir, "attachments"));
    const path = await realpath(part.path);
    const location = relative(root, path);
    if (
      !location ||
      location === ".." ||
      location.startsWith(".." + sep) ||
      isAbsolute(location) ||
      !(await stat(path)).isFile()
    )
      throw new Error("Invalid attachment path");
    const bytes = await readFile(path);
    const text = decodeTextFile(bytes);
    const mimeType =
      (typeof part.mimeType === "string" &&
        /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(part.mimeType) &&
        part.mimeType) ||
      filePresentation(path)?.mime ||
      (text === null ? "application/octet-stream" : "text/plain");
    return text === null
      ? resource(path, "text/plain", embedBinaryResource(mimeType, bytes))
      : resource(path, mimeType, text);
  } catch (error) {
    throw new Error(`无法读取附件「${part.name || part.path}」，请重新添加`, {
      cause: error,
    });
  }
}

export async function agyPromptBlocks(input, { cwd, configDir, capabilities }) {
  const skills = new Set();
  const blocks = [];
  for (const part of input) {
    if (part.type !== "file" && part.type !== "skill") {
      blocks.push(...acpContent([part]));
      continue;
    }
    if (!capabilities?.embeddedContext)
      throw new Error("当前 Antigravity ACP 连接不支持内嵌文件和技能");
    if (part.type === "file") {
      blocks.push(await attachment(part, configDir));
      continue;
    }
    if (skills.has(part.path)) continue;
    const skill = await selectedSkill(part, cwd);
    skills.add(skill.path);
    blocks.push(resource(skill.path, "text/markdown", skill.text));
  }
  return blocks;
}
