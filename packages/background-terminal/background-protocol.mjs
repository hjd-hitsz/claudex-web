export const BACKGROUND_INSTRUCTIONS =
  "Claudex Web 开启后台终端功能时，原生 exec_command 达到前台等待上限后会返回运行中的会话 ID，同一进程继续在后台运行。没有其他工作时可以直接结束当前轮次，独立服务会保留仍在运行的终端，并在命令退出后向原对话提交 background_completed 结果以自动唤醒。无需轮询、调用 sleep 或重新执行命令。也可用 background_start 直接提交构建、测试、数据处理等有明确结束条件的长命令。background_list 列出当前对话任务，background_read 按需读取日志，background_cancel 停止任务并取消自动续跑。";

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
    BACKGROUND_INSTRUCTIONS,
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
