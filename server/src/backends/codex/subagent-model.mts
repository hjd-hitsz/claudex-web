export function subagentModelParams<
  T extends { config?: Record<string, unknown> },
>(
  method: string,
  params: T,
  backend: { subagentModel?: string; subagentEffort?: string },
) {
  if (
    (!backend.subagentModel && !backend.subagentEffort) ||
    !["thread/start", "thread/resume", "thread/fork"].includes(method)
  )
    return params;
  return {
    ...params,
    config: {
      ...params.config,
      ...(backend.subagentModel && {
        "agents.default_subagent_model": backend.subagentModel,
      }),
      ...(backend.subagentEffort && {
        "agents.default_subagent_reasoning_effort": backend.subagentEffort,
      }),
    },
  };
}
