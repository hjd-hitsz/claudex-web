import { readPromptSections } from "../../prompts.mjs";

const execution = readPromptSections("backends/claude/execution.md");

export function planPrompt(review) {
  return execution(review ? "reviewMode" : "planMode");
}

export function claudeQuerySettings(settings) {
  return {
    ...settings,
    attribution: { commit: "", pr: "", sessionUrl: false },
    includeGitInstructions: false,
  };
}
