import { readPromptSections, renderPrompt } from "../../prompts.mjs";
import type {
  CodexSessionSettings,
  NativeCollaboration,
  NativeParams,
} from "./native-protocol.d.mts";

const template = readPromptSections("delegation/workflow.md")(
  "codexSecretaryRole",
);
const marker = "<claudex_secretary>";

export function codexSecretaryTurn(
  params: NativeParams,
  session: CodexSessionSettings,
  role?: string,
): NativeParams {
  // Codex resumes retained history with its latest collaboration settings.
  // A native collaboration update applies the new role to that history.
  const previous = session.collaborationMode;
  if (!role && !previous?.settings?.developer_instructions?.startsWith(marker))
    return params;
  const requested = params.collaborationMode as NativeCollaboration | undefined;
  const model =
    requested?.settings?.model ||
    params.model ||
    previous?.settings?.model ||
    session.model;
  if (!model) throw new Error("Codex 会话缺少已选定的模型。");
  const requestedEffort = requested?.settings?.reasoning_effort;
  return {
    ...params,
    collaborationMode: {
      mode: requested?.mode ?? previous?.mode ?? "default",
      settings: {
        model,
        reasoning_effort:
          requestedEffort !== undefined
            ? requestedEffort
            : (params.effort ??
              previous?.settings?.reasoning_effort ??
              session.reasoningEffort ??
              null),
        developer_instructions: role
          ? renderPrompt(template, { role })
          : (requested?.settings?.developer_instructions ?? null),
      },
    },
  };
}
