import { readFileSync } from "node:fs";
import { promptSections } from "../../shared/prompt-sections.mjs";

const promptDirectory = new URL("../../prompt/", import.meta.url);

export function readPrompt(path) {
  return readFileSync(new URL(path, promptDirectory), "utf8").replace(
    /\r?\n$/,
    "",
  );
}

export function readPromptSections(path) {
  return promptSections(readPrompt(path), path);
}

/** @param {string} template @param {Record<string, string>} variables */
export function renderPrompt(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (!Object.hasOwn(variables, name))
      throw new Error(`缺少提示词变量 ${match}`);
    return variables[name];
  });
}
