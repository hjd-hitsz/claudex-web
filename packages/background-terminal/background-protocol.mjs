export const MIN_CHECK_DELAY_MS = 60_000;
const MAX_DELAY_MS = 604_800_000;
const CHECK_ESTIMATE =
  "Choose the first time a fresh status check would materially help. Estimate it from the actual work: for a download, use remaining size and observed throughput when available; for a build or test, use known run times, the current phase, or work remaining. Budget more time if little is known. Use minutes or longer and briefly explain the basis. The one-minute minimum is a lower bound, not a suggested interval. For status needed now, use background_read once. Never use short timers, sleep, or repeated reads as polling.";

export const BACKGROUND_INSTRUCTIONS = [
  "When background_start is available, use it as the initial execution call for a command you expect to take minutes, such as a large download or a lengthy build or test. Use foreground execution for quick commands.",
  "If a foreground exec_command unexpectedly returns a running session ID, the same process can continue in the background. Do not restart it just to move it to the background.",
  "Provide check_after_ms on every background_start. This is a one-shot soft check: if the job is still running, background_check_due wakes this conversation to review it while the process continues. An exit can wake the conversation sooner through background_completed. Set timeout_ms only for a genuine hard execution limit that warrants stopping the process.",
  CHECK_ESTIMATE,
  "After a check, if continued waiting is useful, set a fresh estimate for the same job with background_schedule_check. Briefly explain the progress or other evidence behind the estimate. Confirm a stall using task-specific evidence before calling background_cancel. Quiet output or a missed estimate alone does not establish a stall. After an unexpected native handoff, background_list gives the tracked job ID for scheduling.",
  "Once the job is running, do only requested work that can actually proceed independently. If the next step depends on the result, give a brief status update in your final response and end this turn. The task service wakes the conversation at the check or when the job exits.",
].join("\n");

export const BACKGROUND_TURN_CONTEXT = {
  claudex_background_execution: {
    kind: "application",
    value: BACKGROUND_INSTRUCTIONS,
  },
};

const jobId = { type: "string", description: "后台工具返回的任务 ID" };
const checkDelay = {
  type: "integer",
  minimum: MIN_CHECK_DELAY_MS,
  maximum: MAX_DELAY_MS,
  description: `Required delay in milliseconds until a one-shot check if still running. The process continues. ${CHECK_ESTIMATE}`,
};
const tool = (name, description, properties, required = []) => ({
  name,
  description,
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
    "Start an expected minutes-long command directly in the background. Use this for large downloads and lengthy builds or tests. Returns immediately with a job ID. When subsequent work depends on the result, finish the turn after a brief status update. The job's completion automatically resumes the conversation.",
    {
      command: {
        type: "string",
        description: "在当前对话工作目录执行的 shell 命令",
      },
      title: { type: "string", description: "简短任务名称" },
      check_after_ms: checkDelay,
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: MAX_DELAY_MS,
        description:
          "可选硬时限，单位毫秒。到期终止进程，仅用于确实需要限制运行时长的任务。",
      },
    },
    ["command", "title", "check_after_ms"],
  ),
  tool(
    "background_schedule_check",
    "Set or replace the next one-shot check for an existing running job in this conversation. Use its background job ID from background_start or background_list. The check leaves the process running and does not change any hard timeout.",
    { job_id: jobId, check_after_ms: checkDelay },
    ["job_id", "check_after_ms"],
  ),
  tool(
    "background_read",
    "读取当前对话后台任务的状态和日志。按需读取，无需轮询等待结束。",
    {
      job_id: jobId,
      offset: {
        type: "integer",
        minimum: 0,
        description: "日志字节偏移；省略时读取末尾",
      },
    },
    ["job_id"],
  ),
  tool("background_list", "列出当前对话的后台任务及完成结果投递状态。", {}),
  tool(
    "background_cancel",
    "停止当前对话的指定后台任务及其子进程，并取消自动续跑。",
    { job_id: jobId },
    ["job_id"],
  ),
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
