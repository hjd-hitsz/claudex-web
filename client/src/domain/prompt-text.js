import messages from "../../../prompt/composer/messages.md?raw";
import messageContext from "../../../prompt/references/message-context.md?raw";
import { promptSections } from "../../../shared/prompt-sections.mjs";

export const composerPrompt = promptSections(messages, "composer/messages.md");
export const referencePrompt = promptSections(
  messageContext,
  "references/message-context.md",
);
