# 未来规划

本文件记录 Claudex Web 已知、需要长期跟踪的能力缺口与后续规划，作为问题登记与实施排期的统一入口。各专题分别说明原生现状、本项目当前实现或计划、切回原生的条件；能力补齐后更新对应条目，不保留过期内容。

## Antigravity 能力缺失

Antigravity（agy）的 ACP 服务端缺少若干产品交互所需的能力。Claudex Web 先在桥接层做替代实现，等 agy 原生补齐后立即切换回原生。

判定口径以本机 `agy acp` 的实际响应为准。只有对应 ACP 方法返回 `-32601 Method not found`，或能力协商与事件流中没有等价信息，才登记为 ACP 缺口；仅是网页尚未接入的原生能力不计入替代实现范围。

基线版本为 agy 1.5.18。复查方式是运行 `node scripts/agy-acp-probe.mjs`：脚本在临时的 HOME 与 XDG 目录中启动 `agy acp`，不读取真实用户配置，也不发起模型请求，逐项输出 supported / missing。升级 agy 后先跑该脚本，再与下表逐项比对。

## 替代实现约定

所有为 agy 补齐缺失能力的临时代码统一放在 `server/src/backends/agy/tmp_function/`，由该目录的 README 维护命名与结构约定。每个文件开头注明三项内容：对应的 ACP 缺口、`-32601` 证据或缺失字段、切回原生的条件。原生实现可用后，删除对应临时文件并移除前端兜底分支，不保留两套并行逻辑。

## 缺口登记

| 前端功能                       | agy 1.5.18 的 ACP 现状                                                                                                                       | 本项目实现                                                                                                                                                                                                                                                                                                                             | 切换为原生的条件                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 按轮次分叉会话（“从这里继续”） | `session/fork`、`session/fork_at` 返回 `-32601`；提示词 `/fork` 只产生普通回复                                                               | 已由 `tmp_function/session-history.mjs` 创建新网页对话和原生会话，首次提交重放截至所选轮次的用户、助手、工具结果与文件变更摘要；原会话保持不变                                                                                                                                                                                         | `session/fork` 可用且能返回新会话标识，并由原生保留工具上下文                                      |
| 原位编辑上一条消息并重发       | `session/rewind`、`session/revert`、`session/rollback` 返回 `-32601`                                                                         | 已由 `tmp_function/session-history.mjs` 截断本地轮次、创建新原生会话并重放保留上下文，再提交编辑后的消息；网页对话标识不变，原原生会话保留                                                                                                                                                                                             | 上述回退方法任一可用并回推历史变更事件                                                             |
| 历史重放的工具结果             | ACP 的 `tool_call_update` 未携带结果正文，原生 `steps` 表保留同一工具调用 ID 与提交给模型的输出                                              | 已由 `tmp_function/history-tool-results.mjs` 在 1.5.18 下只读补齐已完成通用工具的结果摘要，单项摘要上限 4,000 字符                                                                                                                                                                                                                     | 原生分叉或回退保留工具上下文，或 ACP 事件提供完整工具结果                                          |
| 改名、归档、删除同步到原生历史 | `session/rename`、`session/set_title`、`session/archive`、`session/delete` 返回 `-32601`                                                     | 已由 `tmp_function/native-history-actions.mjs`、`native-history-index.mjs` 和 `native-history-transaction.mjs` 实现：改名写原生 annotations；归档把当前原生 DB 移到 `.claudex-history/archived` 并从网页恢复；删除核对空闲、委派结果和执行端后台终端后，事务清理当前原生 DB、索引与侧车。编辑或整理前保留的上一原生会话仍可在 agy 查看 | 对应元数据方法可用                                                                                 |
| 后台任务面板与 `/stop`         | `session/tasks/list`、`thread/backgroundTasks/list`、`thread/backgroundTerminals/list` 返回 `-32601`                                         | 已由 `tmp_function/background-tasks.mjs` 按当前 agy 会话的 Codex 委派读取 Claudex 后台任务服务；无运行项时不渲染计数和列表，单项停止与 `/stop` 作用于本会话终端；agy CLI `/tasks`、Codex 原生终端和 Claude 原生 Bash 仍由各自运行时管理                                                                                                | ACP 提供任务列举、日志读取与单项取消                                                               |
| 插件与 MCP 状态                | 没有 `plugin/installed`、`mcpServerStatus/list` 的等价方法                                                                                   | 已由 `tmp_function/plugin-status.mjs` 只读 `agy plugin list --json` 与 `agy mcp list`，并用当前 ACP 会话的 MCP 工具清单和就绪回执显示 `claudex_delegation`；读取失败保留另一项且不报错                                                                                                                                                 | ACP 提供插件与 MCP 查询接口                                                                        |
| 生成中途 steer 消息            | `session/steer`、`turn/steer` 返回 `-32601`；同一会话的第二次 `session/prompt` 被接受，旧请求可能提前返回 `end_turn`                         | 已由 `tmp_function/session-steer.mjs` 在同一 ACP 会话追加 `session/prompt`，沿用当前网页轮次与更新流；纯文本补充在原请求结束后处理，最新请求结束后结算轮次                                                                                                                                                                             | ACP 提供运行中轮次的显式 steer 方法，并保持当前流、已生成内容与轮次语义                            |
| 手动整理上下文                 | `session/compact` 返回 `-32601`；自定义秘书代理的命令目录没有 `compact`，`/compact` 被当作普通消息                                           | 已由 `tmp_function/session-compact.mjs` 使用隔离摘要代理生成摘要，创建新的原生会话并原子切换；摘要不进入正文                                                                                                                                                                                                                           | ACP 能在保留秘书角色和委派工具的前提下整理同一会话，并发出已生效的整理事件                         |
| 自动整理的完成记录             | ACP 只发送 `usage_update`，未发送检查点生命周期或整理事件                                                                                    | 已由 `tmp_function/compaction-checkpoint.mjs` 只读比较原生会话数据库中的已完成检查点，整理后显示完成记录                                                                                                                                                                                                                               | ACP 发出 `compaction_update` 或等价的整理事件                                                      |
| 项目技能与原生斜杠命令         | `skills/list`、`session/skills/list` 返回 `-32601`；秘书代理的 `available_commands_update` 提供原生命令，但工作区定制隔离使目录不含项目技能  | 已由 `tmp_function/project-skills.mjs` 与 `embedded-resources.mjs` 实现：按工作目录至仓库根列出 `.agents/skills` 等项目技能，显式选中后内嵌当前 `SKILL.md` 正文；原生命令来自 ACP 目录，经 `session/prompt` 交由 agy 展开，并在补入恢复上下文时保持提示开头                                                                            | ACP 在保持秘书定制隔离时提供项目技能列举与显式调用，或秘书代理继承项目技能且不引入工作区规则和钩子 |
| 普通文件内嵌资源               | `promptCapabilities.embeddedContext` 接收 `resource.text`；`resource.blob` 在 `session/prompt` 中被接受但不进入模型请求；图片走 ACP `image`  | 已由 `tmp_function/embedded-resources.mjs` 与 `binary-resource.mjs` 实现：文本附件以 `resource.text` 携带原文；二进制附件以文本资源携带原媒体类型和 Base64 字节；图片保留 `image`，代码行引用沿用带位置的文本。Base64 编码占用模型上下文，格式解析取决于模型                                                                           | ACP 将 `resource.blob` 的字节和原始媒体类型送入模型请求                                            |
| 逐轮 Token 明细缺失            | `session/prompt` 响应的 `usage` 在上游缺少 `usageMetadata` 时整体缺失，`usage_update` 仍提供上下文占用；原生 `gen_metadata` 同步缺少该轮计数 | 客户端直接使用 ACP 上报的逐轮字段；缺失时本轮显示「本轮明细未上报」，已保存的历史轮次仍可查看，不做估算                                                                                                                                                                                                                                | 上游缺少 `usageMetadata` 时 agy 仍提供可核对计数，或 ACP 提供补录接口                              |

项目技能范围是工作目录至仓库根的 `.agents/skills` 及 `.agent`、`_agents`、`_agent` 别名下的直接技能目录。个人技能目录和插件提供的技能不在当前替代实现范围内。

## 明确不接入

以下能力按当前产品定位不纳入适配，登记在此避免重复评估：

- agy 原生子代理：委派模式下的子任务统一由 Codex 或 Claude Code 执行，不使用 agy 自身子代理。
- 计划模式与 `/goal`：秘书与委派场景不需要，网页保持隐藏。
- 网页发起 agy 原生登录：复用 agy 自身的登录状态，本项目不为任何后端提供替代登录。

## 跟踪流程

1. agy 升级后运行 `node scripts/agy-acp-probe.mjs`，保存输出。
2. 将输出与本表逐项比对：由 missing 变为 supported 的能力，切换到原生实现。
3. 切换后删除 `tmp_function` 中对应的临时文件，并移除前端的降级与兜底分支。
4. 更新本表的“本项目实现”与“切换条件”两列，保持登记状态与代码一致。
