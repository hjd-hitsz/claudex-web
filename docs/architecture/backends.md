# 多后端架构契约与实施规范

本文档定义 Claudex Web 连接与调度多个底层 AI 运行时（Codex、Claude Code、Antigravity）的核心系统架构、接口契约及状态流转标准。后端适配层负责吸收原生协议差异，向前端统一工作台提供一致的产品操作语义。

---

## 1. 系统架构与分层设计

Claudex Web 采用“统一应用工作台 + 通用会话管理 + 插件化后端适配器”的分层架构：

```mermaid
flowchart TD
    subgraph Client ["前端应用层 (Browser Client)"]
        UI["统一工作台：会话、富文本输入、工作区、设置"]
        State["前端状态机：连接管理、草稿同步、事件总线"]
    end

    subgraph CoreServer ["服务端核心 (Server Core)"]
        Router["协议路由与资源调度 (Router)"]
        ConvMgr["通用会话管理器 (Conversation Manager)"]
        WorkspaceSvc["宿主工作区服务：文件、内容搜索、网页交互终端 (PTY)"]
    end

    subgraph Adapters ["后端适配层 (Adapters)"]
        CodexAdapter["Codex 适配器\n(WebSocket 客户端)"]
        ClaudeAdapter["Claude 网页适配器\n(Worker IPC 客户端)"]
        AgyAdapter["Antigravity 网页适配器\n(Worker IPC 客户端)"]
    end

    subgraph Runtimes ["原生执行层 (Native Runtimes)"]
        CodexServer["Codex app-server"]
        ClaudeWorker["Claude 独立执行服务 (Worker Process)\n• SDK 持续流式会话\n• 状态与后台任务持久化"]
        AgyWorker["Antigravity 独立执行服务\n• agy acp 子进程 (JSON-RPC)\n• ACP 提示词与委派 MCP"]
    end

    UI <--> State
    State <-->|WebSocket / LAN RPC| Router
    Router --> WorkspaceSvc
    Router <--> ConvMgr
    ConvMgr <--> CodexAdapter
    ConvMgr <--> ClaudeAdapter
    ConvMgr <--> AgyAdapter
    CodexAdapter <-->|JSON-RPC| CodexServer
    ClaudeAdapter <-->|Unix Socket / 行式 JSON| ClaudeWorker
    AgyAdapter <-->|Unix Socket / 行式 JSON| AgyWorker
```

### 1.1 核心职责划分

- **服务端核心路由与标识映射**：负责管理全局连接与资源标识转换。默认 Codex 保留原生 ID，其他后端统一投影为 `backend:<后端ID>:<原生ID>`，屏蔽各原生 ID 的命名冲突与协议差异。
- **宿主工作区服务 (`server/src/workspace/service.mjs`)**：统一提供本地文件操作、基于 `rg --fixed-strings` 的代码片段内容精准匹配（`codeLine`）、文件名模糊搜索（`fuzzyFileSearch`），以及由 `node-pty` 持有的网页交互终端。
- **通用会话管理器 (`server/src/conversation-manager/`)**：作为所有会话活跃状态与跨会话协作事实的全局单一事实源（Single Source of Truth），统一汇聚轮次生成状态与后台终端状态。
- **后端适配层 (`server/src/backends/`)**：实现标准化的适配器接口，吸收不同运行时的进程生命周期、认证环境与原生协议。

---

## 2. 后端适配器通用契约 (Backend Adapter Contract)

所有后端适配器均在 `server/src/backends/manager.mjs` 中通过工厂组装，满足统一的服务端契约方法：

```typescript
interface BackendAdapter {
  connect(): Promise<void> | void;
  ready: boolean;
  capabilities: BackendCapabilities;
  receive(client: ClientContext, message: RpcMessage): Promise<void>;
  state(): BackendStateSnapshot;
  releaseClient(client: ClientContext): void;
  releaseUnusedThreads(): Promise<void> | void;
  close(): Promise<void> | void;
  workspaceOwner: "backend" | "bridge";
}
```

### 2.1 核心契约方法与生命周期行为

1. **握手与就绪判定 (`connect`, `ready`, `capabilities`)**：
   - `shared/product-contract.mjs` 冻结了导出的工作区方法、会话方法与 Antigravity 委派方法清单；
   - **Codex**：`connect` 建立原生 WebSocket 连接，在成功完成原生 `initialize` 握手并收到 `initialized` 响应后置 `ready: true`；
   - **Claude Code 与 Antigravity**：适配器先连接底层的独立 Worker IPC 服务，取得当前 Worker 的就绪快照后置 `ready: true`；
   - `capabilities` 声明真实可用的模型列表、上下文窗口大小及思考强度档位。

2. **请求代理与资源标识转换 (`receive`)**：
   - 接收经过路由分发的产品 RPC 请求；适配器负责在浏览器全局标识与底层原生标识之间进行解包与包装；
   - 客户端提问回答、审批确认及工具请求均通过统一通道双向中继。

3. **工作区所有权与命令路由 (`workspaceOwner`)**：
   - **Codex (`workspaceOwner: "backend"`)**：工作区文件操作与原生命令交由底层 app-server 执行；当跨主机连接时直接操作远端工作区；
   - **Claude Code 与 Antigravity (`workspaceOwner: "bridge"`)**：工作区文件操作与命令由服务端宿主工作区服务统一承接；
   - **网页交互终端**：所有后端的 `lan/terminal/*` 均独立于 `workspaceOwner`，由宿主 `node-pty` 统一管理。

4. **客户端连接释放与会话回收 (`releaseClient`, `releaseUnusedThreads`, `close`)**：
   - **Codex 链路**：
     - `releaseClient`：移除指定浏览器连接的会话订阅权，并触发空闲释放检查；
     - 空闲释放机制：已落盘持久化的空闲会话即使仍在网页中打开，也能释放桥接连接占用的原生订阅；若存在进行中轮次、上下文整理、活动目标、后台终端交接或在途请求，则自动推迟释放；
     - 启动参数配置 `-c thread_unload_delay_secs=0`，使无订阅的空闲会话能够被底层及时卸载；
   - **Claude Code 链路**：
     - `releaseClient` 为空操作（会话由独立常驻 Worker 管理，浏览器关闭不中断模型任务）；
     - `releaseUnusedThreads`：向 Worker 发送 IPC `release` 指令；Worker 内部每 30 秒扫描一次，当会话空闲满 5 分钟且无运行轮次、无未决提问、无活动目标且无 `running` / `pending` 后台任务时，关闭该会话对应的 SDK 查询进程；
   - **Antigravity 链路**：
     - 会话由 ACP 会话内部独立的空闲计时器进行生命周期回收。

---

## 3. 通用会话管理器 (Conversation Manager)

通用会话管理器独立于各原生适配器，集中处理会话活跃度归并、多后端目录分页与跨会话消息调度。

### 3.1 会话活动状态机与多源归并 (`activity.mjs`)

`projectConversationActivity` 将各事实所有者提供的当前状态按会话合并。每项事实都独立进入 `activities`，数组有值时 `live` 为 `true`。单值 `status` 使用以下顺序中首项活动，活动清空后返回 `idle` 或保留来源的 `unknown`。

| `activities` 优先顺序                   | 事实与退出条件                                                       |
| --------------------------------------- | -------------------------------------------------------------------- |
| `waitingForApproval`、`waitingForInput` | 原生或桥接交互请求仍待答复                                           |
| `compacting`、`reverting`               | 上下文整理或文件撤销的运行生命周期                                   |
| `running`、`queued`                     | 原生交互轮次或等待处理的运行时输入                                   |
| `goal`                                  | 原生目标处于自动执行的 `active` 状态                                 |
| `background`                            | 原生后台终端、Claude 后台命令或后台任务服务确认进程运行中            |
| `delegating`                            | 主会话存在已接收、启动中、运行中、等待输入的委派，或委派结果正在回投 |
| `subAgents`                             | 运行中的 Codex 子会话或 Claude 本地代理任务                          |
| `collaborating`、`waitingForPeer`       | 合作消息仍在投递或核对，或发起方明确登记的回复等待尚未结束           |

生成、后台和委派事实分别以 `generating`、`background` 和 `delegating` 字段公开。审批、输入与整理期间可以保留进行中轮次，同时暂停 `generating` 指示。桥接保留 `turnId` 供网页跟踪实际轮次结束。

原会话与委派主会话采用同一请求分类。模型提问和普通 MCP elicitation 进入 `waitingForInput`，命令、文件、额外权限和明确标记为工具审批的请求进入 `waitingForApproval`。Codex 桥接声明 `openai/standard-form-input`，由原生运行时决定是否上报表单或 URL 请求。`approvalPolicy: "never"` 允许向符合条件的用户根会话下发表单，URL 请求仍受原生审批策略控制。

Codex 通过 `thread/loaded/list`、`thread/backgroundTerminals/list` 和 `thread/read` 组合原生会话及子会话元数据，通过 `thread/goal/get` 和 `thread/queue/list` 查询已加载、已发现或收到原生状态事件的会话。后台任务服务按落盘任务记录反查所属 `threadId`，向实际任务服务核实进程状态，再读取已卸载会话的元数据。委派投影按原生运行时和主会话 ID 索引持久化 `tasks` 与 `notices`，执行结果回投进入 `queued` 或 `submitting` 时继续保持活跃，直到回投结算。

Claude Worker 提供运行中轮次、权限和输入等待、持久化输入队列、目标、整理、文件撤销和后台任务状态。Antigravity Worker 提供 ACP 轮次、替换旧轮次时等待提交的新输入、问题与整理事实，管理器从秘书状态文件读取持久化委派。网页交互终端按工作目录和终端进程 ID 寻址，独立于以会话 ID 挂载的后台工作。

网页通过 `lan/conversations/activity` 获取跨已启用后端的 `{ activities, complete }` 快照。`list_active_threads` 使用同一投影查询调用者所在运行时的会话，返回 `status`，并为同时具有多种活动的会话返回 `activities`。

### 3.2 跨会话协作与通信账本 (`store.mjs` & `manager.mjs`)

管理器通过内置的 SQLite 账本（`<configDir>/conversation-manager/messages.sqlite`）提供安全的会话间通信（`thread_chat`）：

- **数据结构与去重**：`messages` 表以 `(sender_runtime, sender, request)` 为唯一键，防止重复派发；
- **回复等待**：发起方调用 `thread_chat` 的 `send` 时可传 `expectReply: true`。管理器在账本中持久化等待状态，收到成功投递的关联回复、原消息投递失败或发起方调用 `stop_waiting` 时结束等待。`reply` 使用原消息 ID 关联；
- **状态流转与退避重试**：
  - 投递调度经历 `accepted` $\rightarrow$ `dispatching` $\rightarrow$ `delivered` / `failed`；
  - 若提交中断或服务重启，残留的 `dispatching` 重置为 `unknown` 并进入回执核对；
  - 投递退避间隔从 5 秒按倍数增长至 60 秒，并由会话生命周期事件即时唤醒；
- **原生投递适配**：
  - Codex：以携带结构化 `toolOutput` 的原生轮次提交并核对历史记录；
  - Claude Code：以唯一消息 UUID 核对 Worker 队列及 SDK 消息历史，支持在生成中同轮动态注入。

---

## 4. 后端专有运行时与协议实现

### 4.1 Claude 独立 Worker 架构与热替换

- **受限 IPC 通信**：
  - 网页桥接与 Worker 通过受限 Unix Domain Socket 通信，路径基于 `stateDir` 的绝对路径哈希与用户身份确定，权限严格限制为目录 `0700`、socket `0600`；
  - 数据传输采用单行上限 128 MiB 的逐行 JSON-RPC 协议；
- **进程管理与部署模式**：
  - 支持 systemd 用户服务单元或脱离终端的守护进程启动；
- **代码修订哈希与热替换 (Worker Revision)**：
  - 桥接计算 `server/src`、`shared` 下所有 `.mjs`、`.json` 及 `package.json` 的 SHA-256 综合哈希；
  - 当检测到代码版本或执行配置变化且当前 Worker 完全空闲时，发送 `shutdown` 请求并重启新代次 Worker；
  - 若 Worker 存在在途请求或活动轮次，原子拒绝替换（返回 `EWORKERBUSY`），确保用户任务不中断。

### 4.2 Antigravity 秘书后端与委派全链路

- **双层架构通道**：
  - 网页桥接经由 Unix IPC 连接独立的 agy Worker；Worker 内部作为 ACP Client 通过子进程标准输入输出与 `agy acp`（Agent Control Protocol）交换逐行 JSON-RPC；
- **提示词与模式注入**：
  - 会话创建与续接时，通过 ACP 的 `_meta.antigravity.systemPrompt.append` 字段注入秘书角色定义；
  - 角色正文选取优先级：当前预设 $\rightarrow$ 用户保存的 `secretary.md` $\rightarrow$ 仓库内置默认 `prompt/secretary/secretary.md`；
- **权限与审批自动处理**：
  - ACP 原生的 `session/request_permission` 权限请求优先选择 `allow_once`，次选 `allow_always`；
  - 执行端的提问与审批通过独立事件流中继至主会话，由用户确认后回传；
- **委派派单与证据调阅 (`claudex_delegation`)**：
  - 秘书端通过 MCP 工具 `ask_codex` / `ask_claude` 发起异步委派，任务与回执持久化存入 `delegation/state.json`；
  - 底层完成后，Worker 在主会话空闲时调用 `session/prompt` 将阶段结论与产物回投；
  - 秘书端使用 `read_delegation_step` 按 8 位短 ID 查询原生 Rollout 或工具日志，单次超长详情支持分段流式拼接。

---

## 5. 架构质量与验收契约

所有多后端特性的维护与演进必须遵循以下技术准则：

1. **单一事实源与防穿透**：所有关于会话是否活跃（live）、处于何种运行阶段的计算，必须严格收拢在通用会话管理器内，严禁前端或业务路由私自拼凑逻辑；
2. **后台任务与会话生命周期绑定**：无论是 Codex 任务日志反查还是 Claude Worker 任务列表，只要进程存在，会话即处于 `live: true`，并在结束轮次后准确呈现 `background`；
3. **确定性证据链**：所有异步委派与跨会话协作，均需落盘记录唯一请求标识、发送/接收端点与原生回执，具备断线恢复与幂等重试能力。
