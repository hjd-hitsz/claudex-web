# Codex 后台终端 MCP

启用后，预计耗时数分钟的大文件下载、构建或测试由模型直接用 `background_start` 启动。后续步骤依赖任务结果时，模型简短汇报后结束本轮，任务服务在命令退出后自动续跑原对话。短命令继续使用前台执行。原生 `exec_command` 意外超出前台等待上限时，同一进程可在后台继续，独立服务保留原生终端订阅并投递结果。Claudex Web 默认关闭此扩展。Claude Code 使用自身的后台 Bash、任务输出和完成通知，两端共用网页的 `/stop` 入口。

## 启用

扩展适用于 Linux、Node.js 24.5 或更高版本，以及同机监听 WebSocket 的 Codex app-server。任务服务与 Codex 使用同一系统账户和工作区。命令以该账户执行，服务在启动任务前核对原生会话的完全访问权限。

在网页的「设置 → 其他设置」勾选「为Codex开启后台终端功能」。首次开启会通过用户级 systemd 启动独立任务服务，默认状态目录位于网页配置目录的 `background-terminal` 下。新建对话或重新加载已卸载的对话后，工具连接中会显示四项工具。原生终端接手与此开关联动，关闭后新命令沿用 Codex 原有生命周期。已接手的原生终端和已提交的 MCP 任务继续运行，仍可通过 `/stop` 查看和停止。

手动运行独立服务时，在 Claudex Web 源码根目录运行以下示例，地址应与目标 Codex app-server 一致。用户级 systemd 单元持有任务服务及命令的进程组，独立于网页和 MCP stdio 连接。

```bash
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/codex-background-terminal"
entry="$(realpath packages/background-terminal/cli.mjs)"
upstream="ws://127.0.0.1:8765"
systemd-run --user --unit=codex-background-terminal --collect \
  --property=Restart=on-failure \
  "$(command -v node)" "$entry" serve "$state_dir" "$upstream"
```

已有部署会沿用 `CLAUDEX_BACKGROUND_TASKS_DIR` 指定的任务服务，首次读取时开关自动开启，之后以网页保存的偏好为准。停止独立任务服务使用 `systemctl --user stop codex-background-terminal`，服务会结束仍在运行的命令。示例创建的 transient 单元适用于当前用户管理器的运行期。

独立使用时可从 `packages/background-terminal` 打包安装，安装后的命令为 `codex-background-terminal`。同一 app-server 的客户端也可通过 Codex 原生配置注册 stdio 入口。以下命令写入运行该 app-server 的 Codex 配置，工具按原生 MCP 调用元数据确定所属对话。

```bash
codex mcp add claudex_background -- "$(command -v node)" "$entry" mcp "$state_dir"
```

## 任务与结果

输入区左侧的终端图标显示当前对话正在运行的任务数，点击打开右上角的工作区概览。概览中的「后台终端」列表支持单独停止任务，点击任务在右侧查看终端收到的标准输出与标准错误。命令重定向到文件的内容保存在对应文件中。输出跟随任务刷新，任务结束后保留最后一段。Codex 任务面板显示最后 8 KiB，可从「完整日志」下载已保存的输出。Claude Code 的原生后台 Bash 使用相同入口。

- `background_start(command, title, timeout_ms?)` 在当前对话的实际目录执行 shell 命令，返回任务 ID。相同会话的同一工具调用 ID 对应同一任务。
- `background_list()` 列出当前对话的任务、执行状态与结果投递状态。
- `background_read(job_id, offset?)` 读取任务状态、退出码及输出。省略字节偏移时取末尾，从零开始按 `nextOffset` 翻页可读取保留的日志。每页最多 32 KiB，每个任务最多保留 64 MiB；超过上限时记录 `logTruncated`。
- `background_cancel(job_id)` 停止 MCP 任务的 Unix 进程组，或调用 Codex 原生终端停止接口，并抑制尚未提交的续跑。网页 `/stop` 可一并停止当前对话的原生终端及 MCP 任务。Claude Code 使用 SDK 的 `stopTask`。

任务服务通过私有目录中的 Unix socket 接受本机同用户请求。目录权限为 0700，socket、任务状态和日志权限为 0600。每个状态目录绑定一个 Codex 后端地址。后台服务可在网页桥接关闭后继续工作。原生终端由 Codex app-server 持有，独立订阅用于防止正常会话卸载。任务服务重启后将遗留的运行记录标为中断。

启用时，网页通过原生轮次的 `additionalContext` 提供前后台选择和交还轮次的应用指令。等待后台任务靠完成通知触发，`sleep` 仍可用于其他需要定时等待的场景。

成功、非零退出及超时都产生终态。服务等待原对话空闲后恢复原生会话，用 `turn/start` 投递退出状态、输出文件与日志摘要，并持有订阅直到续跑轮次结束。同次请求用 `additionalContext` 提醒模型继续用户已要求且结果允许的后续步骤，并汇报结果。对话按原生轮次顺序显示续跑和模型回复。续跑失败、中断或模型没有输出正文时，对话直接显示任务结果与输出入口。模型已读取的终态和已取消任务会退出待投递队列。提交响应丢失时进入 `uncertain`，服务按通知 ID 核对原对话历史；任务工具仍可主动读取结果。

ZCode 的 Bash 结束后先入队并保存面向模型的任务通知，再由运行时执行对应会话。通知包含任务标识、状态、输出文件和摘要，由独立来源标记区分人工输入。Claudex Web 使用 Codex 原生轮次请求中的结构化工具结果和应用上下文分别承载任务事实与汇报要求。[ZCode 后台调度](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts) · [ZCode 通知持久化](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts) · [Codex 原生提交](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server/src/request_processors/turn_processor.rs)
