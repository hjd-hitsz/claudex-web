import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../../private-file.mjs";

const defaultContent = await readFile(
  new URL("./secretary.md", import.meta.url),
  "utf8",
);
const roleFile = (stateDir) => join(stateDir, "secretary.md");

export async function readAgyRole(stateDir) {
  try {
    const content = await readFile(roleFile(stateDir), "utf8");
    return { content, defaultContent, customized: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { content: defaultContent, defaultContent, customized: false };
  }
}

export async function saveAgyRole(stateDir, content) {
  if (typeof content !== "string" || !content.trim() || content.includes("\0"))
    throw new Error("请输入有效的角色设定文本");
  if (Buffer.byteLength(content, "utf8") > 64 * 1024)
    throw new Error("角色设定大小不能超过 64 KiB");
  const customized = content !== defaultContent;
  if (customized) await writePrivateFile(roleFile(stateDir), content);
  else await rm(roleFile(stateDir), { force: true });
  return { content, defaultContent, customized };
}
