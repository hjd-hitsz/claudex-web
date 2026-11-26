import { readPromptSections, renderPrompt } from "../prompts.mjs";

const collaboration = readPromptSections("conversation/collaboration.md")(
  "collaboration",
);

export function conversationCollaborationInstructions(serverName) {
  return renderPrompt(collaboration, { serverName });
}
