import { taskPrompt } from "./prompts.mjs";

export const MIN_CHECK_DELAY_MS = 60_000;
const MAX_DELAY_MS = 604_800_000;
const CHECK_ESTIMATE = taskPrompt("checkEstimate");

export const BACKGROUND_INSTRUCTIONS = taskPrompt("instructions").replace(
  "{{checkEstimate}}",
  () => CHECK_ESTIMATE,
);

export const BACKGROUND_TURN_CONTEXT = {
  claudex_background_execution: {
    kind: "application",
    value: BACKGROUND_INSTRUCTIONS,
  },
};

const jobId = { type: "string", description: taskPrompt("job_id") };
const checkDelay = {
  type: "integer",
  minimum: MIN_CHECK_DELAY_MS,
  maximum: MAX_DELAY_MS,
  description: taskPrompt("check_after_ms").replace(
    "{{checkEstimate}}",
    () => CHECK_ESTIMATE,
  ),
};
const tool = (name, properties, required = []) => ({
  name,
  description: taskPrompt(name),
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});
export const BACKGROUND_TOOLS = [
  tool(
    "background_start",
    {
      command: {
        type: "string",
        description: taskPrompt("command"),
      },
      title: { type: "string", description: taskPrompt("title") },
      check_after_ms: checkDelay,
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: MAX_DELAY_MS,
        description: taskPrompt("timeout_ms"),
      },
    },
    ["command", "title", "check_after_ms"],
  ),
  tool(
    "background_schedule_check",
    { job_id: jobId, check_after_ms: checkDelay },
    ["job_id", "check_after_ms"],
  ),
  tool(
    "background_read",
    {
      job_id: jobId,
      offset: {
        type: "integer",
        minimum: 0,
        description: taskPrompt("offset"),
      },
    },
    ["job_id"],
  ),
  tool("background_list", {}),
  tool("background_cancel", { job_id: jobId }, ["job_id"]),
];

export function validateBackgroundArguments(name, args) {
  const definition = BACKGROUND_TOOLS.find((entry) => entry.name === name);
  if (!definition) throw new Error("未知后台工具");
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("工具参数必须为对象");
  for (const key of Object.keys(args))
    if (!Object.hasOwn(definition.inputSchema.properties, key))
      throw new Error("未知参数：" + key);
  for (const key of definition.inputSchema.required) {
    if (!Object.hasOwn(args, key)) throw new Error("缺少必填参数：" + key);
    if (
      definition.inputSchema.properties[key].type === "string" &&
      (typeof args[key] !== "string" || !args[key].trim())
    )
      throw new Error(key + " 必须为非空文字");
  }
  if (args.command?.length > 100000 || args.title?.length > 200)
    throw new Error("命令或任务名称过长");
  for (const [key, field] of Object.entries(definition.inputSchema.properties))
    if (
      field.type === "integer" &&
      Object.hasOwn(args, key) &&
      (!Number.isSafeInteger(args[key]) ||
        args[key] < field.minimum ||
        args[key] > (field.maximum ?? Number.MAX_SAFE_INTEGER))
    )
      throw new Error(
        key === "check_after_ms"
          ? "check_after_ms 须为 60,000 至 604,800,000 毫秒，请按任务进度估算下次检查时间"
          : key + " 超出有效范围",
      );
}
