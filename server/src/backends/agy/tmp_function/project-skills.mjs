// ACP 缺口：秘书代理缺少可选择的项目技能目录及显式调用接口。
// 探测证据：agy 1.5.18 的 skills/list、session/skills/list 返回 -32601。
// inheritCustomizations=false 时 available_commands_update 省略项目技能，
// 同名斜杠输入以普通文字进入模型。该设置隔离项目规则和钩子。
// 切换条件：ACP 能在保持定制隔离时列出并显式调用秘书会话的项目技能。
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readPromptSections, renderPrompt } from "../../../prompts.mjs";

const customizationFolders = [".agents", ".agent", "_agents", "_agent"];
const skillPrompt = readPromptSections("references/message-context.md")(
  "selectedSkill",
);

async function present(operation, fallback) {
  try {
    return await operation;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return fallback;
    throw error;
  }
}

async function projectRoots(cwd) {
  const roots = [cwd];
  for (let root = cwd; dirname(root) !== root;) {
    if (await present(stat(join(root, ".git")), null)) return roots;
    root = dirname(root);
    roots.push(root);
  }
  return [cwd];
}

async function readSkill(path) {
  const file = await present(stat(path), null);
  if (!file?.isFile()) return null;
  const text = await present(readFile(path, "utf8"), "");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter || !text.slice(frontmatter[0].length).trim()) return null;
  const [, header] = frontmatter;
  const field = (key) =>
    new RegExp("^" + key + ":[ \\t]*(.*)$", "m")
      .exec(header)?.[1]
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  const name = field("name");
  if (!name) return null;
  const description = field("description");
  return { name, path, description, text };
}

export async function projectSkills(cwd) {
  const folders = (await projectRoots(cwd)).flatMap((root) =>
    customizationFolders.map((name) => join(root, name, "skills")),
  );
  const skills = new Map();
  for (const folder of folders) {
    const entries = await present(readdir(folder, { withFileTypes: true }), []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = await readSkill(join(folder, entry.name, "SKILL.md"));
      if (skill && !skills.has(skill.name.toLowerCase()))
        skills.set(skill.name.toLowerCase(), skill);
    }
  }
  return [...skills.values()];
}

export async function selectedSkill(input, cwd) {
  const path = input.path;
  const folder = typeof path === "string" && dirname(dirname(path));
  if (
    !folder ||
    basename(path) !== "SKILL.md" ||
    basename(folder) !== "skills" ||
    !customizationFolders.includes(basename(dirname(folder))) ||
    !(await projectRoots(cwd)).includes(dirname(dirname(folder))) ||
    join(folder, basename(dirname(path)), "SKILL.md") !== path
  )
    throw new Error("请从当前 Antigravity 项目的技能列表重新选择技能");
  const skill = await readSkill(path);
  if (!skill || skill.name !== input.name)
    throw new Error(`技能「${input.name}」已移动、删除或改名，请重新选择`);
  return { path, text: renderPrompt(skillPrompt, skill) };
}
