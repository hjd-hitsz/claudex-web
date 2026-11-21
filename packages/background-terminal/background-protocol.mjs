export const BACKGROUND_INSTRUCTIONS = [
  "When background_start is available, use it as the initial execution call for a command you expect to take minutes, such as a large download or a lengthy build or test. Use foreground execution for quick commands.",
  "If a foreground exec_command unexpectedly returns a running session ID, the same process can continue in the background. Do not restart it just to move it to the background.",
  "Once the job is running, do only requested work that can actually proceed independently. If the next step depends on the result, give a brief status update in your final response and end this turn. Do not wait with sleep, poll the job or terminal, or fill the wait with unrelated work. The task service will automatically start a new turn with background_completed so you can continue.",
].join("\n");

export const BACKGROUND_TURN_CONTEXT = {
  claudex_background_execution: {
    kind: "application",
    value: BACKGROUND_INSTRUCTIONS,
  },
};

const jobId = { type: "string", description: "后台工具返回的任务 ID" };
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
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: 604800000,
        description: "可选执行时限，单位毫秒",
      },
    },
    ["command", "title"],
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
  for (const key of definition.inputSchema.required)
    if (typeof args[key] !== "string" || !args[key].trim())
      throw new Error(key + " 必须为非空文字");
  if (args.command?.length > 100000 || args.title?.length > 200)
    throw new Error("命令或任务名称过长");
  for (const [key, max] of [
    ["offset", Number.MAX_SAFE_INTEGER],
    ["timeout_ms", 604800000],
  ])
    if (
      args[key] !== undefined &&
      (!Number.isSafeInteger(args[key]) ||
        args[key] < (key === "offset" ? 0 : 1) ||
        args[key] > max)
    )
      throw new Error(key + " 超出有效范围");
}
