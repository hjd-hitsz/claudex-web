import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readPromptSections, renderPrompt } from "../../prompts.mjs";

const prompts = readPromptSections("backends/claude/execution.md");
const snapshot = prompts("projectInstructions");
const [snapshotStart] = snapshot.split("{{cwd}}");
const snapshotEnd = snapshot.split("{{files}}")[1];
const hookStart = "UserPromptSubmit hook additional context: " + snapshotStart;

// Claude retains these hook frames in its native history. Standard Messages
// uses only the latest frame when projecting that history into top-level system.
export function projectInstructionFrame(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf(hookStart);
  if (start < 0 || (start && text[start - 1] !== "\n")) return null;
  const end = text.indexOf(snapshotEnd, start + hookStart.length);
  if (end < 0) return null;
  return { start, end: end + snapshotEnd.length };
}

async function instruction(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`读取项目指令失败（${path}）：${error.message}`, {
      cause: error,
    });
  }
}

function instructionDirectories(cwd) {
  const directories = [];
  let directory = resolve(cwd);
  while (true) {
    directories.unshift(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return directories;
}

// The submit hook owns root AGENTS files. Claude retains its own CLAUDE.md,
// settings, and instructions discovered outside the submit hook's scope.
export function nativeInstructionExcludes(cwd) {
  return instructionDirectories(cwd).map((directory) =>
    join(directory, "AGENTS.md").replace(
      /[*?\[\]{}()]/gu,
      (character) => "[" + character + "]",
    ),
  );
}

export async function readProjectInstructions(cwd) {
  const sections = [];
  for (const scope of instructionDirectories(cwd)) {
    let path = join(scope, "AGENTS.override.md");
    let content = await instruction(path);
    if (content === null) {
      path = join(scope, "AGENTS.md");
      content = await instruction(path);
    }
    if (content === null) continue;
    sections.push(
      renderPrompt(prompts("projectInstructionFile"), {
        path: JSON.stringify(path),
        directory: JSON.stringify(scope),
        content,
      }),
    );
  }
  return renderPrompt(snapshot, {
    cwd: JSON.stringify(resolve(cwd)),
    files: sections.length
      ? sections.join("\n\n---\n\n")
      : prompts("projectInstructionsEmpty"),
  });
}
