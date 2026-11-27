import { readPromptSections, renderPrompt } from "../../prompts.mjs";
import { agyConversationContext } from "./acp-messages.mjs";
import { compactedContext } from "./tmp_function/session-compact.mjs";
import { agyHistoryPrompt } from "./tmp_function/session-history.mjs";

export { agyPromptBlocks } from "./tmp_function/embedded-resources.mjs";

const continuation = readPromptSections("delegation/workflow.md")(
  "secretaryContinuation",
);

export async function compileAgyPrompt(
  session,
  blocks,
  activity,
  repair,
  execution,
) {
  const { input } = activity;
  let promptBlocks = input.userInput
    ? await execution.forwardingContext(session.id, blocks)
    : blocks;
  const submittedInput = input.userInput || input.notice;
  const contextPending =
    (repair || session.nativeContextPending) && submittedInput;
  const checkpoint = session.contextCheckpoint;
  const checkpointPending = Boolean(
    checkpoint && submittedInput && (checkpoint.pending || contextPending),
  );
  const history = submittedInput && agyHistoryPrompt(session);
  if (history) promptBlocks = [history, ...promptBlocks];
  else if (contextPending) {
    const boundary = session.turns.findIndex(
      ({ id }) => id === checkpoint?.throughTurnId,
    );
    const history = agyConversationContext(session.turns.slice(boundary + 1));
    if (history)
      promptBlocks = [
        { type: "text", text: renderPrompt(continuation, { history }) },
        ...promptBlocks,
      ];
  }
  if (checkpointPending)
    promptBlocks = [compactedContext(checkpoint), ...promptBlocks];
  if (input.nativeCommand) {
    const command = blocks[0];
    const position = promptBlocks.indexOf(command);
    if (position >= 0 && promptBlocks.length > 1)
      promptBlocks = [
        { ...command, text: command.text + "\n\n" },
        ...promptBlocks.slice(0, position),
        ...promptBlocks.slice(position + 1),
      ];
  }
  return {
    promptBlocks,
    contextPending,
    checkpointPending,
    historyPending: Boolean(history),
  };
}
