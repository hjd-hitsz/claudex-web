import { readAgyRole } from "../agy/role-settings.mjs";
import { readPromptSections, renderPrompt } from "../../prompts.mjs";
import {
  claudeDelegationToolName,
  delegationToolName,
} from "../../conversation-manager/tools.mjs";

const workflow = readPromptSections("delegation/workflow.md");

export const delegationBackends = ["codex", "claude"];
const sourceBackends = [...delegationBackends, "agy"];

const idPattern = /^[\w-]{1,80}$/;
const routeValue = (value) =>
  typeof value === "string" &&
  value.length <= 256 &&
  !/[\s\x00-\x1f\x7f]/u.test(value);

export function validateDelegationSettings(input) {
  const delegationPrompts = input.delegationPrompts ?? [];
  if (!Array.isArray(delegationPrompts) || delegationPrompts.length > 100)
    throw new Error("委派提示词最多可保存 100 份");
  const ids = new Set();
  const names = new Set();
  const prompts = delegationPrompts.map(({ id, name, content }) => {
    if (
      typeof id !== "string" ||
      !idPattern.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 80 ||
      names.has(name.trim()) ||
      typeof content !== "string" ||
      !content.trim() ||
      content.includes("\0") ||
      Buffer.byteLength(content) > 64 * 1024
    )
      throw new Error("请填写唯一的提示词名称和有效的正文（最多 64 KiB）");
    ids.add(id);
    names.add(name.trim());
    return { id, name: name.trim(), content };
  });

  const delegates = {};
  if (
    Object.keys(input.delegates || {}).some(
      (id) => !delegationBackends.includes(id),
    )
  )
    throw new Error("委派执行端无效");
  for (const id of delegationBackends) {
    const {
      enabled = false,
      model = "",
      effort = "",
      providerId = "",
    } = input.delegates?.[id] || {};
    if (
      typeof enabled !== "boolean" ||
      ![model, effort, providerId].every(routeValue) ||
      (id === "codex" && providerId) ||
      (!model && (effort || providerId))
    )
      throw new Error("请选择有效的执行模型和思考强度");
    delegates[id] = { enabled, model, effort, providerId };
  }
  const sourcePrompts = input.delegationSourcePrompts;
  if (
    sourcePrompts &&
    Object.keys(sourcePrompts).some((id) => !sourceBackends.includes(id))
  )
    throw new Error("委派发起端无效");
  const delegationSourcePrompts = Object.fromEntries(
    sourceBackends.map((id) => {
      const legacy =
        id === "agy"
          ? input.secretaryPromptId
          : input.delegates?.[id]?.promptId;
      const promptId = (sourcePrompts ? sourcePrompts[id] : legacy) ?? "";
      if (promptId !== "" && !ids.has(promptId))
        throw new Error("请选择有效的委派提示词");
      return [id, promptId];
    }),
  );
  return { delegates, delegationPrompts: prompts, delegationSourcePrompts };
}

export async function resolveSourcePrompt(settings, source) {
  const promptId = settings.delegationSourcePrompts?.[source];
  const preset = settings.delegationPrompts?.find(({ id }) => id === promptId);
  return preset?.content ?? (await readAgyRole(settings.stateDir)).content;
}

export async function resolveNativeSecretaryRole(settings, source) {
  return [
    renderPrompt(workflow("nativeSecretary"), {
      backend: source === "claude" ? "Codex" : "Claude Code",
      tool: source === "claude" ? claudeDelegationToolName : delegationToolName,
    }),
    await resolveSourcePrompt(settings, source),
  ].join("\n\n");
}

export function buildDelegationSelection(settings, target) {
  const { model, effort, providerId } = settings.delegates[target];
  return { model, effort, providerId };
}
