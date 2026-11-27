export function claudeQuerySettings(settings) {
  return {
    ...settings,
    attribution: { commit: "", pr: "", sessionUrl: false },
    includeGitInstructions: false,
  };
}
