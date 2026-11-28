# Codex 后台终端 MCP

启用后，预计耗时数分钟的下载、构建或测试由模型用 `background_start` 启动，并按工作量估算首次检查时间。后续步骤依赖任务时，模型简短汇报后结束本轮。任务服务在检查时间到达且命令仍运行时唤醒原对话，命令提前退出则直接投递结果。短命令使用前台执行。原生 `exec_command` 意外超过前台等待上限时，独立服务接手原进程的订阅，接手后也可以设置检查时间。Claudex Web 默认关闭此扩展。Claude Code 使用原生后台 Bash，两端共用网页的 `/stop` 入口。

## 启用

扩展适用于 Linux、Node.js 24.5 或更高版本，以及同机监听 WebSocket 的 Codex app-server。任务服务与 Codex 使用同一系统账户和工作区。命令以该账户执行，服务在启动任务前核对原生会话的完全访问权限。

在网页的「设置 → 通用」开启 Codex 后台终端功能。首次开启时，网页启动独立任务服务，默认状态目录位于网页配置目录的 `background-terminal` 下。普通进程部署直接启动任务进程，启动日志写入该目录的 `worker.log`。使用 `claudex-web.service` 托管网页时，独立用户单元负责托管任务进程。两种部署下网页退出后，任务服务均继续运行。升级到支持研究委派沙箱的版本时，在运行中的任务和结果投递结算后更新已有的独立任务服务，使其读取桥接写入任务目录的委派账本绑定。

普通会话新建或重新加载已卸载的对话后，工具连接中会显示五项工具，原生终端接手与此开关联动。已接手的原生终端和已提交的 MCP 任务继续运行，仍可通过 `/stop` 查看和停止。Codex 研究委派使用原生只读命令，任务服务跟踪其原生长进程并在只读轮次投递结果。研究委派的权限契约见 [委派全链路](architecture/backends.md#42-antigravity-秘书后端与委派全链路)。

单独运行扩展时，可在 Claudex Web 源码根目录运行以下示例。地址应与目标 Codex app-server 一致。

```bash
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/codex-background-terminal"
entry="$(realpath packages/background-terminal/cli.mjs)"
upstream="ws://127.0.0.1:8765"
node "$entry" serve "$state_dir" "$upstream"
```

已有部署会沿用 `CLAUDEX_BACKGROUND_TASKS_DIR` 指定的任务服务，首次读取时开关自动开启，之后以网页保存的偏好为准。前台运行的任务服务可用 Ctrl+C 结束，服务退出时会清理其管理的命令。

独立使用时可从 `packages/background-terminal` 打包安装，安装后的命令为 `codex-background-terminal`。同一 app-server 的客户端也可通过 Codex 原生配置注册 stdio 入口。以下命令写入运行该 app-server 的 Codex 配置，工具按原生 MCP 调用元数据确定所属对话。

```bash
codex mcp add claudex_background -- "$(command -v node)" "$entry" mcp "$state_dir"
```

## 任务与结果

输入区左侧的终端图标显示当前对话正在运行的任务数，点击打开工作区概览。「后台终端」列表会显示已安排的下次检查时间，支持单独停止任务，点进任务可查看标准输出和标准错误。命令重定向到文件的内容保存在指定文件中。输出跟随任务刷新，任务结束后保留最后一段。Codex 任务面板显示最后 8 KiB，可从「完整日志」下载已保存的输出。Claude Code 的原生后台 Bash 使用相同入口。

- `background_start(command, title, check_after_ms, timeout_ms?)` 在当前对话的实际目录执行 shell 命令，返回任务 ID。相同会话的同一工具调用 ID 对应同一任务。必填的 `check_after_ms` 为单次检查的相对时间，范围为 60,000 至 604,800,000 毫秒。可选的 `timeout_ms` 为硬时限，到时终止进程。
- `background_schedule_check(job_id, check_after_ms)` 为同一对话中仍在运行的任务设置或替换下次检查时间。已接手的 Codex 原生终端使用 `background_list` 返回的任务 ID。检查点触发后，进程继续执行。仍需等待时，模型根据任务阶段、日志和剩余工作重新估算。需要立即了解状态时直接读取任务，60 秒下限用于防止秒级轮询。
- `background_list()` 列出当前对话的任务、执行状态、已安排的下次检查时间和完成投递状态。
- `background_read(job_id, offset?)` 读取任务状态、退出码及输出。省略字节偏移时取末尾，从零开始按 `nextOffset` 翻页可读取保留的日志。每页最多 32 KiB，每个任务最多保留 64 MiB；超过上限时记录 `logTruncated`。
- `background_cancel(job_id)` 停止 MCP 任务的 Unix 进程组，或调用 Codex 原生终端停止接口，并取消尚未提交的检查及完成通知。网页 `/stop` 可一并停止当前对话的原生终端及 MCP 任务。Claude Code 使用 SDK 的 `stopTask`。

任务服务通过私有目录中的 Unix socket 接受本机同用户请求。目录权限为 0700，socket、任务状态和日志权限为 0600。每个状态目录绑定一个 Codex 后端地址。后台服务可在网页桥接关闭后继续工作。原生终端由 Codex app-server 持有，独立订阅用于防止正常会话卸载。任务服务重启后将遗留的运行记录标为中断。

启用时，网页通过原生轮次的 `additionalContext` 提供前后台选择、估算检查时间和续跑的应用指令。模型按任务阶段和实际依赖估算检查时间。任务进展依赖其他会话时，模型可通过 [通用会话管理器](architecture/backends.md#3-通用会话管理器-conversation-manager) 直接询问对方的当前状态和预计就绪时间，并依据回复安排或调整检查。若只需等待回复，模型结束本轮，回复送达时会自动唤醒原对话。短间隔的连续唤醒和读日志轮询由工具约定约束。

服务等待原对话空闲后通过 `turn/start` 投递 `background_check_due` 或 `background_completed`，持有原生订阅直到续跑轮次结束。检查通知携带任务状态、运行时长、检查时间和日志摘要。发送前重新核对任务状态及检查点版本，改期、停止或退出使旧检查失效。成功、非零退出及硬超时各自产生终态结果，并记录任务的总耗时。完成投递独立于一个或多个检查轮次。对话按原生轮次顺序显示任务摘要与模型回复，摘要卡片显示任务状态、耗时和日志预览，整卡打开任务输出。已读取的终态退出待投递队列，运行中读日志仍保留最终结果投递。提交响应丢失时进入 `uncertain`，按事件名和通知 ID 核对历史。任务工具仍可主动读取结果。

ZCode 的 Bash 结束后先入队并保存面向模型的任务通知，再由运行时执行对应会话。通知包含任务标识、状态、输出文件和摘要，由独立来源标记区分人工输入。Claudex Web 使用 Codex 原生轮次请求中的结构化工具结果和应用上下文分别承载任务事实与汇报要求。[ZCode 后台调度](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts) · [ZCode 通知持久化](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts) · [Codex 原生提交](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server/src/request_processors/turn_processor.rs)
