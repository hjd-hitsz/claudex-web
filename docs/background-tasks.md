# Codex 后台终端 MCP

启用后，Codex 可以把构建、测试等长命令交给后台终端，取得任务 ID 后继续工作或结束当前轮次。独立服务保存输出，命令结束后向原对话投递结果。Claudex Web 默认关闭此扩展。Claude Code 使用自身的后台 Bash、任务输出和完成通知，两端共用网页的 `/stop` 入口。

## 启用

扩展适用于 Linux、Node.js 24.5 或更高版本，以及同机监听 WebSocket 的 Codex app-server。任务服务与 Codex 使用同一系统账户和工作区。命令以该账户执行，服务在启动任务前核对原生会话的完全访问权限。

在网页的「设置 → 其他设置」勾选「为Codex开启后台终端功能」。首次开启会通过用户级 systemd 启动独立任务服务，默认状态目录位于网页配置目录的 `background-terminal` 下。新建对话或重新加载已卸载的对话后生效，工具连接中会显示四项工具。关闭开关后，已提交的任务继续运行，仍可通过 `/stop` 查看和停止。

手动运行独立服务时，在本分支源码根目录运行以下示例，地址应与目标 Codex app-server 一致。用户级 systemd 单元持有任务服务及命令的进程组，独立于网页和 MCP stdio 连接。

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

- `background_start(command, title, timeout_ms?)` 在当前对话的实际目录执行 shell 命令，返回任务 ID。相同会话的同一工具调用 ID 对应同一任务。
- `background_list()` 列出当前对话的任务、执行状态与结果投递状态。
- `background_read(job_id, offset?)` 读取任务状态、退出码及输出。省略字节偏移时取末尾，从零开始按 `nextOffset` 翻页可读取保留的日志。每页最多 32 KiB，每个任务最多保留 64 MiB；超过上限时记录 `logTruncated`。
- `background_cancel(job_id)` 停止该任务的 Unix 进程组，并抑制尚未提交的续跑。网页 `/stop` 同时列出该对话的 Codex 原生后台终端和 MCP 任务，可一并停止。Claude Code 使用 SDK 的 `stopTask`。

任务服务通过私有目录中的 Unix socket 接受本机同用户请求。目录权限为 0700，socket、任务状态和日志权限为 0600。每个状态目录绑定一个 Codex 后端地址。后台服务可在网页关闭后继续工作，恢复时会将遗留的运行记录标为中断。

成功、非零退出及超时都产生终态。服务等待原对话空闲后，通过带有 `toolOutput` 的原生 `turn/start` 投递退出状态与日志摘要。模型已读取的终态和已取消任务会退出待投递队列。提交响应丢失时进入 `uncertain`，服务按通知 ID 核对原对话历史；任务工具仍可主动读取结果。

后台执行与会话归属的设计参考了 ZCode 的后台 Bash 契约和按会话读取日志的实现。[后台 Bash 行为](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/docs/bash-background-parity.md) · [输出读取](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/core/src/runtime/methods/background-bash-output.ts)
