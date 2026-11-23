# 开发者指南

本文面向修改、测试和发布 Claudex Web 的开发者。安装发行包及日常使用见 [README](../README.md)，运行配置和故障处理见[部署与维护](deployment.md)。实现设计见[架构说明](architecture.md)，版本选择和完整发布流程见[版本管理](versioning.md)。

## 后台终端回归

独立 MCP 服务与 Codex 适配的部署方式见[后台终端说明](background-tasks.md)。命令及日志回归纳入单元测试。修改执行、取消和唤醒时按受影响后端验证真实原生调用。运行 `node --import ./tests/helpers/test-console.mjs tests/integration/codex-background-terminal.mjs`，在 systemd 命令不可用的夹具中通过网页 RPC 开启后台终端，以真实 Codex 和本机模拟 Responses 服务验证任务退出、通知进入模型请求、原生续跑终态和网页结果。关闭桥接的场景先确认独立进程仍可响应及原生对话卸载，再放行隔离任务完成。另覆盖仅独立服务持有订阅且启用零延迟卸载，以及没有回复正文时刷新仍可查看任务结果、退出码和日志。运行 `node tests/integration/claude-runtime-lifecycle.mjs` 对照 Claude SDK 的原生后台执行、停止和唤醒。

运行 `node --import ./tests/helpers/test-console.mjs tests/integration/codex-background-live.mjs`，通过隔离网页桥接和真实 `gpt-6-luna` 验证执行选择。测试使用 `CODEX_VALIDATION_HOME`、`CODEX_HOME` 或默认 Codex 目录的 ChatGPT 文件认证，在临时目录运行。长下载和构建在首轮完成后才放行，断言首轮直接调用 `background_start`、自动续跑完成文件校验，以及短命令使用前台执行。默认让模型可调用 `sleep`，设置 `BACKGROUND_SLEEP_DISABLED=1` 可对照。

## 本地环境与源码启动

开发环境需要 Linux、Node.js 24.5+、npm、OpenSSL、Linux PAM 和 pamtester。验证原生后端时，安装并配置对应的 Codex 或 Claude Code CLI。网页终端依次使用 `SHELL` 环境变量、系统账户的登录 shell、`/bin/sh`，支持 Bash、Zsh 等 shell。终端集成测试覆盖本机已安装的 sh、Bash 和 Zsh，专用浏览器回归的额外依赖见对应章节。本项目使用根目录 npm workspaces 和单一 `package-lock.json` 管理前后端依赖。

克隆仓库后，在项目根目录安装依赖并创建配置：

```bash
git clone https://github.com/hjd-hitsz/claudex-web.git claudex-web
cd claudex-web
npm ci
```

首次配置时，执行 `cp .env.example .env` 创建配置文件；已有 `.env` 时直接使用现有配置。源码命令从项目根目录 `.env` 加载环境变量，外部环境变量优先；配置项含义见[配置说明](deployment.md#配置)。

在不同终端分别启动后端、网页桥接和前端开发服务器：

```bash
# 终端一：已有后端监听配置中的地址时可复用
npm run start:backend
```

```bash
# 终端二：网页桥接服务
npm start
```

```bash
# 终端三：前端开发服务器
npm run dev
```

打开 Vite 输出的 HTTPS 地址。Vite 与桥接复用证书，代理验证桥接证书；本地开发同样使用系统账户登录。开发服务器将 `/rpc`、`/healthz` 和 `/api` 代理到网页桥接端口，模型调用和工具执行按对话归属交给 Codex 或 Claude Code，思考内容翻译由桥接适配独立的本地翻译子项目。

验证生产构建时，执行 `npm run build`，再通过网页桥接地址访问，默认 `https://127.0.0.1:8766`。生产服务直接读取 `client/dist`，前端更新后重新构建并刷新网页即可；桥接代码更新后需要重启网页服务。

## 项目结构

源码目录及职责见[架构设计](architecture.md#模块与依赖)。

`packages/translation-engine` 独立维护模型下载、完整性校验、原生分词器和 ONNX CPU 推理，使用方法见[子项目说明](../packages/translation-engine/README.md)。Linux x64 源码构建需要 C 编译器，发行包包含已构建的分词器。模型由首次启用功能触发下载，测试夹具与模型数据分别管理。

服务图标源文件为 `client/src/assets/claudex-web.svg`。侧栏和欢迎页使用内联 SVG，浏览器标签页使用 `client/public` 中的 PNG、ICO 和触屏图标，通过本站独立路径读取。修改 SVG 后，在安装了 `gdk-pixbuf-thumbnailer` 的 Linux 环境中执行 `npm run icons:generate`，同步生成并提交兼容资源；普通构建与发行包安装直接使用这些资源。验证时同时检查浏览器实际请求的图标地址、响应类型及标签页显示，手机浏览器的验证独立于窄屏页面布局检查。

快捷命令的 CLI 对照、网页复用入口、专用能力边界及浏览器回归方法见[命令覆盖记录](cli-command-coverage.md)。

CLI 安装回归使用 `server/tests/cli-package.test.mjs` 验证原生平台包选择、下载失败保留旧安装、重试顺序、npm 成功后 CLI 失效及版本不一致。构建后以 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/cli-installation.mjs` 检查设置中的简短提示、诊断展开和安装重试，覆盖深浅主题、窄屏及 80% 至 200% 实际浏览器缩放。截图和构建来源保存在 `.cache/cli-installation/after`。设置 `BROWSER_BEFORE=1` 使用 `.cache/cli-installation-before` 的构建复现旧版诊断布局。

单元和发行包测试通过 `--import ./tests/helpers/test-console.mjs` 预加载测试专用 `Console`，将控制台日志统一送入 stderr。Node.js 将该文本流独立转换为测试日志事件，stdout 专供二进制测试事件，避免旧版测试运行器混读 Unicode 日志导致反序列化错误。模块加载、测试执行和清理阶段均使用同一入口，直接运行单个测试时同样携带此参数。`tests/test-console.test.mjs` 连续十次启动两个并行测试进程，核对中文、emoji、多参数、对象和调用栈日志完整保留，并核对真实断言失败仍返回非零退出状态。上游问题见 [nodejs/node#65934](https://github.com/nodejs/node/issues/65934)。

桥接测试中，首个就绪快照及单次请求响应通过匹配后即移除的监听器读取，后续状态广播使用独立等待与断言。`node --import ./tests/helpers/test-console.mjs --test server/tests/bridge.test.mjs` 覆盖提问回答后的重连、新提问存在时旧提问重复结束触发的状态广播，以及数字请求 ID 的结束通知；固定事件顺序验证初始快照断言仅执行一次。推送后按提交 SHA 核对 GitHub Actions 的完整工作流结果，分别保留本地与远端检查记录。

构建后执行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/slash-commands.mjs`，使用隔离浏览器与模拟后端验证输入开头及正文中途的斜杠建议、Tab 补全、确认、光标中间替换、正文保留、撤销重做、失败恢复、技能及原生命令，并检查深浅主题、桌面及窄屏、80% 至 200% 实际页面缩放与侧栏开关。脚本核对 DPR 和视口，结束时恢复缩放并清理独立浏览器目录。截图与构建来源保存在 `.cache/slash-commands/after`。对照时将 `client/dist` 与 `build-info.json` 复制到 `.cache/slash-commands/before`，以 `BROWSER_BEFORE=1` 运行对照。

正文图片布局回归先执行 `npm run build`，再运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/message-images.mjs`。脚本使用仓库截图与隔离消息、模拟后端和独立浏览器配置，验证消息及文件预览中的图片居中、640 × 480 像素上限、等比缩小、HTML 指定宽度、链接图片、`picture`、大图预览及关闭后的焦点恢复，覆盖深浅主题、窄屏和 80% 至 200% 实际页面缩放。结束时恢复缩放并清理浏览器配置，截图、尺寸测量与构建来源保存在 `.cache/message-images/after`。对照时将生产构建和构建来源保存到 `.cache/message-images/before/dist` 与 `build-info.json`，以 `BROWSER_BEFORE=1` 运行对照。

## 双后端开发与验收

网页维护回归使用 `node --import ./tests/helpers/test-console.mjs --test server/tests/service-maintenance*.test.mjs`，覆盖 systemd 命令夹具、真实 HTTPS 普通进程的 HTTP 重启、npm 安装失败、启动失败回滚、进程身份与退出期限。进程环境夹具将 npm 与 systemctl 放在不同目录，维护进程的 PATH 只含 systemctl，验证环境传递及安装、启动失败时的恢复。构建后运行 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/service-maintenance.mjs`，验证更新与重启按钮的点击、错误反馈、重试及进行状态，核对深浅主题、桌面与窄屏在 80% 至 200% 实际页面缩放下的按钮文案单行显示及卡片边界。截图及构建来源保存在 `.cache/service-maintenance/after`；使用 `BROWSER_BEFORE=1` 对照 `.cache/service-maintenance/before/dist` 中的基线构建。

双后端统一范围、真实协议及工作区路由见[产品契约](architecture/backends.md)，首次请求、流式展示、轮次完成、刷新恢复和错误重试均纳入验收。

公共网页操作在 `server/src/bridge` 维护，原生适配分别位于 `server/src/backends/codex` 和 `server/src/backends/claude`。调整适配器接口时执行 `node --import ./tests/helpers/test-console.mjs --test server/tests/backend-product-contract.test.mjs server/tests/backend-routing.test.mjs`，核对两端的离线偏好、保存通知、失败重试、目录创建、整理写入限制、工作区所有者声明和浏览器代理释放。产品契约夹具使用真实适配器与模拟 app-server，Claude 只执行进程版本检查；真实 CLI/SDK 的执行与恢复由下述验收覆盖。架构检查同时禁止公共桥接依赖具体后端和原生适配器之间的交叉依赖。

真实 Claude Code 回归使用临时配置、原生会话和隔离 Messages 服务。验证 systemd 托管及 cgroup 时需连接用户管理器。运行时可指定本机已安装的可执行文件：

```bash
CLAUDE_EXECUTABLE=/absolute/path/to/claude npm run test:backends
```

该入口依次执行原生会话分支与历史、模型/插件/MCP 目录、项目指令、工具和提问、计划批准、整理、中断、持续输入、目标及后台任务等脚本，记录真实 CLI 版本和各脚本结果，日志位于 `.cache/backend-acceptance`。测试不访问用户对话，模型回应由隔离服务提供。图片验证通过真实 CLI 提交临时 PNG，检查首次供应商请求保留 base64 内容、刷新历史恢复图片地址，以及原生 Read 返回图片后在统一工具结果中的显示数据。`server/tests` 另验证身份、额度窗口与额外用量的转换；原生账户授权和在线余额的验证记录需要相应服务环境，按实际完成的项目单独报告。

`claude-runtime-restart.mjs` 使用临时模型会话及后台 shell，验证网页代理进程 SIGKILL 后执行服务与原生 PID 保持、后台任务继续、重连快照和忙时停止拒绝。默认使用真实 systemd 用户单元，设置 `CLAUDE_NO_SYSTEMD=1` 时使用 systemd 命令不可用且进程继承 `INVOCATION_ID` 的夹具。`claude-worker-upgrade.mjs` 通过隔离源码身份与配置验证忙时待更新、空闲替换、旧桥接保留新代际及多连接行为。`server/tests/claude-worker-client.test.mjs` 以 Unix IPC 协议夹具验证多连接、提问和执行状态透传、关闭桥接及在途请求结算；`claude-worker-location.test.mjs` 核对目录、socket 权限及符号链接替代拒绝。协议夹具与真实系统服务的证据分别记录。

`claude-native-configuration.mjs` 通过真实 CLI 核对既有用户设置、多级软链接技能和原生历史读取，网页状态目录单独配置。夹具在原生设置中保留不同的供应商环境，再通过网页显式选择隔离供应商，验证首次请求到达所选服务、原配置文件保持原样。显式供应商覆盖经原生 `applyFlagSettings` 在输入前通过进程通信应用，凭据保持在受限环境和通信中。

`claude-worker-environment.mjs` 使用自签 HTTPS 模型端点，验证 Node 启动时的额外 CA 与代理配置、包含空格的路径、权限 0600 的环境文件，以及进程参数中省去代理凭据。退出后核对环境文件清理；该测试随 `test:backends` 执行。

项目指令回归通过真实运行时捕获 Messages 请求，核对祖先和当前目录的 AGENTS 指令完整送达、原生 CLAUDE 指令持续保留，以及更新、删除、空快照和读取失败后的下一轮行为。标准 Messages 传输将所需系统上下文放在顶层 `system`。原生历史回归使用临时 JSONL 和真实 SDK，核对 UUID 分支、编辑、补充消息、子代理接收记录、后台自动唤醒锚点和完整分页；历史正文与已确认的展示元数据分别验证。

Codex 的真实模型回归显式指定已配置模型和认证的目录，脚本只复制配置及认证到独立的临时 `CODEX_HOME`，项目和对话记录在临时目录中创建：

```bash
CODEX_VALIDATION_HOME=/absolute/path/to/configured-codex-home CODEX_EXECUTABLE=/absolute/path/to/codex npm run test:codex:live
```

`CODEX_MODEL` 可选，用于指定验收模型。`codex-native-lifecycle.mjs` 通过真实 app-server 与配置的模型执行文件写入和读取、原生文件建议、服务重启后继续同一对话、分支及原生历史读取；2026-11-06 已验证 `codex-cli 0.162.1` 的三个真实轮次。具体结果保存在 `.cache/backend-acceptance/codex-live.json`，与浏览器中的 Codex 协议夹具分别记录。

`CODEX_EXECUTABLE=/absolute/path/to/codex node tests/integration/codex-subscription-release.mjs` 使用真实 app-server、人工持久历史及实际 Codex 适配器，连续执行八组立即重新打开的操作，验证取消订阅确认与 `thread/closed` 之间的等待。此测试使用临时原生目录，模型轮次数为零；`server/tests/codex-close-lifecycle.test.mjs` 另覆盖关闭早于确认、无需关闭的状态和断线失败，HTTPS/WSS 订阅回归覆盖确认后关闭延迟到达。

完整 Codex 网页操作使用相同的隔离配置和真实 app-server：

```bash
CODEX_VALIDATION_HOME=/absolute/path/to/configured-codex-home CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/codex-native.mjs
```

脚本通过登录表单进入临时 HTTPS 网页，实际选择模型并创建文件，验证任务完成、刷新历史、原生文件引用、文件面板，以及编辑重发后的文件和历史内容，保留独立草稿。结果与截图保存在 `.cache/backend-acceptance/codex-browser`；此入口使用真实 Codex 模型，与协议模拟器浏览器回归分别记录。

第三方安装路径的 Claude 验收单独执行：

```bash
CLAUDE_EXECUTABLE=/absolute/path/to/claude node tests/integration/claude-installed-worker.mjs
```

脚本构建网页后实际打包并安装到临时 npm prefix，从安装包加载 worker 客户端并启动独立执行服务。验证无 Git、无源码锁文件时的原生文件读取、项目技能、模型配置、真实 Write 工具落盘、历史恢复及空闲停止，模型响应由隔离 Messages 服务提供。安装日志、包文件和结果保存在 `.cache/backend-acceptance/installed-worker`。`tests/package.test.mjs` 的模拟 Codex 验证继续覆盖其已有安装场景。

生产页面的双后端回归在构建后执行：

```bash
npm run build
CLAUDE_EXECUTABLE=/absolute/path/to/claude CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/dual-backends.mjs
```

浏览器脚本使用独立 HTTPS/WSS 桥接、临时系统登录夹具、Codex 协议模拟器与真实 Claude Code 配合隔离 Messages 服务，验证共享界面、模型选择、草稿、文件引用、执行状态、失败恢复、插件连接及两端归属。截图与记录位于 `.cache/dual-backend-browser`。模拟 Codex 传输、真实 Claude CLI、隔离模型响应及真实外部模型验证分别注明来源。

实际页面缩放使用 `CODEX_BROWSER_ZOOM_ONLY=1` 配合上述真实 Codex 浏览器脚本执行。脚本从 Chromium 设置调整页面缩放，核对 DPR 和 CSS 视口，覆盖桌面与 390 像素窄屏、深浅主题及 80%、100%、125%、150%、200%。验证两行输入、工具栏和模型控件位于视口内、欢迎内容可滚动，以及侧栏开关和关闭按钮；该模式断言模型轮次数为零，截图与测量值保存在 Codex 浏览器证据目录的 `browser-zoom` 中。

使用外部真实模型时，显式设置测试服务及模型：

```bash
CLAUDE_EXECUTABLE=/absolute/path/to/claude MODEL_BASE_URL=https://model.example MODEL_ID=your-model MODEL_API_KEY=your-key npm run test:backends:live
```

该脚本使用临时 Claude 对话验证实际生成、工具与恢复，保留独立结果；远端服务和 GPU 选择由验证环境配置，产品默认值保持通用。验证来源、请求结果和未执行的认证场景写入执行记录。

已有 Python 模块目录的只读说明验收使用独立入口：

```bash
CLAUDE_EXECUTABLE=/absolute/path/to/claude MODEL_BASE_URL=https://model.example MODEL_ID=your-model VALIDATION_CWD=/absolute/path/to/project VALIDATION_DIRECTORY=relative/path/to/python-package node tests/integration/claude-readonly-directory.mjs
```

脚本将“介绍这个文件夹里面各个文件的功能”的请求原文交给真实 Claude Code，以临时配置和原生计划模式读取指定目录。验证成功的工具响应包含实际源码 API、最终正文覆盖目录文件与公开 API、全部模型请求返回 200，以及目标文件 SHA-256 前后相同。`MODEL_API_KEY` 按服务认证要求设置，`VALIDATION_OUTPUT` 可指定证据目录，默认 `.cache/backend-acceptance/original-user-case`。证据包含 `answer.md`、工具事件、原生会话、请求响应和结果报告。该入口读取已有目录，写入仅发生在临时配置及证据目录中。

`claude-model-switch.mjs` 在同一真实 CLI 会话连续执行 A → B → A，使用隔离 Messages 响应触发 Opus、Sonnet、Haiku 三类子代理，检查主请求、子代理请求、持久模型和设置通知均跟随本轮选择。设置 `MODEL_BASE_URL` 与 `MODEL_ID` 后使用真实模型响应，验证 Haiku 子代理。该模式将两个临时测试模型标识转发到同一个指定模型，上游请求限制为 1024 输出 tokens 并关闭思考；上下文容量为 65536，须与测试服务的加载配置一致。`VALIDATION_OUTPUT` 指定请求与报告目录，默认 `.cache/backend-acceptance/model-switch`。测试始终使用临时原生目录与网页状态目录。

### 客户端与既有网页行为查验

2026-11-06 查验本机保存的网页客户端 `codex-lan-client 2.0.0`，目录为 `~/.local/share/codex-lan/client-source`。`src/shortcuts.jsx` 的文件建议逻辑在空查询或目录后缀时读取目录，其余查询调用 `fuzzyFileSearch` 并传入当前目录，保留 60 项及请求代次隔离；同文件的命令注册列出原有网页入口。`src/store.js` 的发送流程根据活动轮次选择 `turn/steer` 或 `turn/start`，通知分派处理 `turn/started` 与 `turn/completed`。这些代码作为既有网页交互和用户体验的查验依据，统一 18 项命令以当前仓库注册表为准。

同日查验 Codex VS Code 扩展 `openai.chatgpt 26.908.40401`，版本来自 `~/.local/share/vscode-lan/code-server-extensions/openai.chatgpt-26.908.40401-linux-x64/package.json`。`webview/assets/app-initial-1e5ee25fb4ec.js` 中的文件查询服务调用原生 fuzzy search 会话启动、更新、停止接口，并保留单次查询接口；`Nhr` 注册 `init` 命令，在提交生成前检查已有 `AGENTS.md`。`app-initial-bca4f920746a.js` 的 `P1t` 处理轮次开始并更新对话状态，整理流程调用 `thread/compact/start`；补充输入提交使用 `turn/steer`。这里记录原生客户端的交互及协议事实，Claude Code 的原生附加命令以其自身当前目录返回结果为准。

2026-11-17 对照本机保留的 Codex VS Code `26.1021.22027` 打包资源：`src-622b307a9baf.js` 的 `Pv` 返回默认模型配置服务，`writeModel` 直接提交 `config/batchWrite`，服务档位写入同样使用该请求并设置 `reloadUserConfig: true`。本机桌面包版本为 `26.1007.21434`，可用资源中未定位到子代理专用设置控件，当前工具环境未提供可操作的客户端窗口。网页子代理设置的生效行为分别通过真实 Codex `0.169.0`、Claude CLI 与隔离模型服务验证；客户端资源仅用于核对偏好保存的请求边界。

以上查验使用本机可取得的源码及已安装打包资源。保存的网页客户端、当前网页产品、Codex 客户端和 Claude Code 运行时各自注明版本与来源；提取资源保留在本机忽略目录，仓库只维护行为结论和隔离验证。

## 格式与验证

子代理模型回归以 `node --import ./tests/helpers/test-console.mjs tests/integration/subagent-models.mjs` 运行真实 Claude CLI 与本机模拟 Messages 服务，覆盖连续轮次、general-purpose 与 Explore、同供应商不同模型、跨供应商同名模型、原生 API Key 与外部供应商的双向路由，以及停用后的失败与恢复。`tests/integration/codex-subagent-models.mjs` 使用真实 Codex app-server 与模拟 Responses 服务，核对未显式指定模型及强度的原生子代理实际使用网页配置。Claude 回归同时检查主代理低强度、子代理高强度到低强度及模型变化在连续轮次中的实际请求，并验证清空后恢复默认。`node tests/integration/claude-subagent-settings-save.mjs` 经过真实管理器、独立执行服务和原生 CLI 完成保存、IPC 重连及连续轮次，核对执行服务与原生主会话 PID 保持、实际请求的新模型和强度以及清空行为；所有原生验证使用临时配置，模型流量只发往本机夹具。原生 OAuth 文件更新和凭据隔离另由 `server/tests/subagent-models.test.mjs` 使用临时文件与模拟端点验证。

构建后使用 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/subagent-models.mjs` 验证两后端同行展示的“供应商 / 模型”及思考强度选择。Codex 显示偏好覆盖代际排序、型号列对齐、缺席型号、键盘勾选及模型候选过滤。子代理配置覆盖独立保存、写入失败保留、重试、刷新恢复与清空。浏览器覆盖深浅主题、桌面与窄屏、80% 至 200% 实际缩放和侧栏收放，证据保存在 `.cache/subagent-models/browser`。

保存性能回归阻塞模型、账户及后端目录读取，验证一次保存请求即可结束并保留当前主模型和草稿，记录完整按钮等待耗时。`client/tests/backend-settings-save.test.js` 与 `server/tests/codex-subagent-settings.test.mjs` 分别检查前端请求边界及真实 Codex 适配器的最新配置读取，配置事务和 IPC 回归覆盖运行任务、写入失败与重连时进程保持。`tests/integration/subagent-models.mjs` 使用真实 Claude CLI 与隔离模型服务验证连续轮次更新模型、强度及清空默认值，并核对主会话实例保持。

文件预览编辑回归在构建后运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/file-editing.mjs`。脚本使用生产构建、真实 Chromium 编辑器及隔离文件协议夹具，核对直接输入、撤销、表格、任务列表、代码、数学语法、相对图片、Mermaid、源码切换、保存与失败重试，并覆盖深浅主题、桌面与窄屏的 80%、100%、125%、150% 和 200% 实际页面缩放。截图与结果位于 `.cache/file-editing/after`，浏览器关闭 GPU，测试结束清理独立配置。旧构建通过 `BROWSER_BUILD_DIR` 指定，设置 `FILE_EDITING_BEFORE=1` 后复现只读预览并将对照截图保存到 `.cache/file-editing/before`。

模型名称布局回归在构建后执行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/model-select.mjs`。脚本使用隔离模型目录及模拟后端，在桌面、平板竖屏和手机窄屏核对完整名称、键盘选择、两行输入正文完整可见、工具栏控件位于视口内，覆盖深浅主题及 80%～200% 实际页面缩放；结束后恢复缩放并清理浏览器配置。截图与测量记录保存在 `.cache/model-select/after`。对照时将构建复制到 `.cache/model-select/before/dist`，设置 `BROWSER_BEFORE=1` 运行对照。

长对话切换回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/history-performance.mjs`。脚本使用生产构建、独立浏览器和 15 轮、3,210 条记录的隔离历史，每页模拟 50 毫秒往返；记录首屏和完整恢复耗时，验证最近消息及输入先可用、自动完整分页、普通状态更新复用 Markdown、读取期间草稿与实时更新保留、历史前插时的阅读位置、目录跳转和快速切换隔离，覆盖深浅主题、80% 至 200% 缩放及窄屏。证据与构建来源保存在 `.cache/history-performance/after`。对照时的构建及来源分别保存为 `.cache/history-performance-before/dist` 和 `build-info.json`，以 `BROWSER_BEFORE=1` 记录同机对照，耗时用于比较同机行为。单元及组件回归同时验证旧接口完整轮次回退、分页失败后的可读记录与重试、实时结果优先及切换隔离。

侧栏收纳回归执行 `SIDEBAR_DENSITY=1 CHROME_PATH=/path/to/chromium node tests/browser/project-pins.mjs`，使用隔离的 Atlas/Beacon 与最近有活动的未分类对话、超过 60 条的后端分页，验证未分类始终位于末尾、固定与未固定的默认收放、每组最新五条、全部展开及收起、刷新重置、键盘操作、深浅主题、80% 至 200% 缩放和手机布局。截图与构建信息保存在 `.cache/sidebar-density-browser/after/`。旧构建及来源位于 `.cache/sidebar-density-before/`，追加 `SIDEBAR_DENSITY_BEFORE=1` 保存旧版全部展开的对照截图。

固定项目排序回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/project-priority.mjs`。脚本使用独立浏览器配置和模拟 WebSocket，对照钉选空项目、较早对话与未钉选项目的最新对话，实际点击固定、取消固定、展开收起及新建入口，验证立即重排、草稿保留和刷新恢复，并保存桌面深浅主题与手机侧栏截图。对照时将生产构建及 `build-info.json` 保存为 `.cache/project-priority-before/dist` 和 `.cache/project-priority-before/build-info.json`，使用 `BROWSER_BEFORE=1` 运行对照；结果和截图写入 `.cache/project-priority/before` 与 `after`。

固定文件夹回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/project-pins.mjs`。脚本使用生产构建、隔离浏览器与模拟 Atlas/Beacon 对话，实际点击图钉和归档按钮，验证固定后全部归档、刷新恢复、空项目新建、取消固定、草稿与同类项目顺序保留、键盘操作、深浅主题及手机布局，结果和截图写入 `.cache/project-pins-browser/after/`。旧构建及来源保存在 `.cache/project-pins-before/dist` 与 `.cache/project-pins-before/build-info.json`，通过 `BROWSER_BEFORE=1` 复现重新加载后空文件夹消失，保存对照截图。取消固定的鼠标与键盘焦点回归同时核对图钉及加号的实际透明度：鼠标移开后隐藏，Tab 聚焦时显示；固定状态仅常显图钉，加号在点击新建对话并移开鼠标后隐藏。通过 `PIN_VISIBILITY_BEFORE=1` 读取 `.cache/project-pin-visibility-before/` 保存的构建及来源，复现鼠标点击保留焦点导致按钮常显，结果保存到 `.cache/project-pins-browser/visibility-before/`。固定记录复用 `cx-projects`，已有手动项目继续保留。

项目模型偏好回归执行 `CHROME_PATH=/path/to/chromium node tests/browser/project-models.mjs`，使用生产构建、隔离的 Atlas/Beacon 项目与模拟后端，通过模型选择框和强度滑块的键盘操作验证保留强度、最近档位、项目切换、刷新恢复及实际发送参数，保存桌面深浅主题和手机截图。对照构建及来源分别保存到 `.cache/project-model-before/dist` 和 `.cache/project-model-before/build-info.json`，以 `BROWSER_BEFORE=1` 运行对照；执行证据写入 `.cache/project-model-browser/`。组件回归同时覆盖历史及迟到恢复、未分类隔离和选择目录时保留草稿附件。

已有对话模型隔离回归使用 `EXISTING_MODEL=1 CHROME_PATH=/path/to/chromium node tests/browser/project-models.mjs`，以项目默认模型 C 与已有对话模型 A 的隔离数据验证打开、刷新、实际发送及从新建界面返回已有对话，并保存桌面深浅主题和手机截图。对照时将生产构建和构建来源保存到 `.cache/existing-model-before/dist` 与 `.cache/existing-model-before/build-info.json`，增加 `BROWSER_BEFORE=1` 运行对照；证据写入 `.cache/existing-model-browser/`。组件回归另覆盖重连初始化、恢复及迟到响应期间手动调整。

同项目新建与服务端保存回归增加 `PROJECT_MODEL_SERVER=1`，从历史恢复一个不同于配置默认值的模型和强度，在尚未手动调整时点击右上角新建，断言完整保留当前选择。测试通过临时 `CLAUDEX_WEB_CONFIG_DIR` 和实际项目存储模块写入文件，清空浏览器存储后重新加载，并重新创建存储实例核对项目设置。结果写入 `.cache/project-model-server-browser/`；对照时构建与构建来源保存到 `.cache/project-model-server-before/`，配合 `BROWSER_BEFORE=1` 运行对照。服务端单元及桥接测试覆盖跨项目连续写入、重建恢复、跨连接同步、旧缓存补齐、无效输入和损坏文件保护；组件测试覆盖保存失败重试及当前选择优先。

```bash
npm run format
npm run architecture:check
npm test
npm run check
```

使用 Prettier 整理格式。检查入口及架构规则见[可执行约束与验证](architecture.md#构建与验证)。组件测试使用 `scripts/test-components.mjs` 的夹具注册加载隔离实现；新增夹具在同一处登记来源、目标和导出。

`.github/workflows/check.yml` 对分支推送和 PR 执行同一完整检查，使用只读仓库权限；同一引用有新检查时取消旧运行。发布工作流在版本标签上独立重复完整检查。

状态容器和 RPC 客户端的单元回归分别位于 `client/tests/application-state.test.js` 和 `client/tests/rpc-client.test.js`。服务应用生命周期回归位于 `server/tests/application.test.mjs`，使用临时 HTTPS 服务验证实例缓存隔离、监听失败和关闭后连接清理。组件总入口 `tests/components/client.mjs` 只组织夹具和场景，新增场景放入对应模块；桥接订阅、写入与整理分别维护测试文件并复用 `tests/helpers/bridge.mjs`。

分支标题回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/fork-titles.mjs`。脚本使用隔离模拟历史和生产构建，实际点击回复分支按钮与侧栏菜单，验证兼容客户端编号、连续分支到两位数、刷新恢复、深浅主题及手机侧栏，同时核对 Codex 创建后直接分页读取历史。截图和构建信息保存到 `.cache/fork-titles-browser/after`。对照时将旧 `client/dist` 与 `build-info.json` 复制到 `.cache/fork-titles-before/`，以 `BROWSER_BEFORE=1` 运行同一脚本。单元与组件测试另覆盖旧后缀、手动改名、独立同名对话、60 字符截断、归档分页和筛选外编号。

测试采用模拟后端，不消耗模型额度，也不修改真实聊天。协议或生命周期变更应补充对应回归测试；真实后端验证使用临时会话或明确的测试数据。领域与状态测试位于 `client/tests`，服务端与桥接测试位于 `server/tests`，组件、浏览器、原生集成及发行包验证位于 `tests` 的对应目录。

输入性能回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/composer-performance.mjs`。脚本使用独立浏览器配置和模拟 WebSocket，载入 60 轮 Markdown 历史及 31 个侧栏对话，通过浏览器输入事件一次写入大段文字并连续补充，记录输入事件到下一绘制帧的耗时和 React 历史渲染次数；断言输入期间历史渲染次数为零，耗时作为同机对照记录。继续验证组合输入、Enter 换行、刷新恢复、发送失败与等待期间继续编辑，保存桌面深浅主题和窄屏截图。结果和构建来源保存在 `.cache/composer-performance/after`；对照时将 `client/dist` 与 `build-info.json` 复制到 `.cache/composer-performance-before/`，分别保存为 `dist` 与 `build-info.json`，以 `BROWSER_BEFORE=1` 运行同一脚本记录历史随输入重渲染的对照结果。`tests/components/composer-performance.mjs` 独立验证共享快照引用、渲染次数、即时发送值、持久化、草稿清理与对话切换。

批注浏览器回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/annotations.mjs`。脚本复制当前生产资源，在独立浏览器配置目录中使用模拟 WebSocket 历史，验证多批注草稿、Enter 完成并返回主输入框、Shift+Enter 换行、悬浮编辑、缩放、窄屏、刷新恢复、失败重试及 Ctrl+Enter 统一提交；截图和构建来源记录默认写入 `.cache/annotations-browser`，可通过 `BROWSER_OUTPUT_DIR` 指定目录。使用 `ANNOTATION_ENTER_BEFORE=1` 对照旧构建，可复现 Enter 插入换行并保存截图。组件回归同时检查输入法组合输入和键码 229 的 Enter 保持编辑。

在同一浏览器回归入口设置 `ANNOTATION_MARKDOWN=1`，以隔离历史验证现有纯文本批注的公式恢复、新建批注提交及刷新、回复中的编号引用、选区复制、整条消息复制和 Markdown 文件预览复制。剪贴板检查覆盖部分加粗文字、公式、代码、链接、列表和表格。截图和布局测量覆盖深浅主题、手机窄屏及 80% 至 200% 浏览器页面缩放。可用 `BROWSER_BEFORE=1`、`BROWSER_BUILD_DIR` 和 `BROWSER_BUILD_INFO` 验证旧构建中的公式拆行。

后台恢复浏览器回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/connection-recovery.mjs`。脚本使用隔离模拟 WebSocket 与真实标签切换，在桌面和手机尺寸下验证连接正常时持续更新、断线后延迟重连、后台历史补齐、工作过程展开状态、同步期间编辑草稿及向上翻阅位置。记录消息和输入框的 DOM 实例及移除事件，确认恢复期间保留已有界面，并核对页面时间来源保持一致。截图及构建路径写入 `.cache/background-recovery-browser/after`。对照时将旧 `client/dist` 复制到 `.cache/background-recovery-before/dist`，以 `BROWSER_BEFORE=1` 运行同一脚本。

视觉调整的浏览器检查使用生产构建与隔离的模拟历史，覆盖正文、代码块、工作过程、输入框草稿、右侧详情、设置弹窗及欢迎页。浅色、深色、跟随系统深色和窄屏分别核对文字对比度、选中状态、换行、控件位置及全宽布局。80%、100%、125%、150% 和 200% 缩放按物理窗口尺寸除以缩放倍数设置 CSS 视口，并同步设置设备像素比，检查发送按钮和底栏的可见性。对照时采用相同数据和视口截图，图片及构建信息保存在 `.cache` 中。

账户点数展示对照本机 Codex VS Code 客户端 `26.1021.22027` 的 `webview/assets/rail-menu-cae2fdac3263.js`：`fe` 读取并校验 `credits.balance`，`It` 展示余额，`banner-suppression-f959351fdc5c.js` 的 `O` 将后端点数字段映射到 `hasCredits`、`unlimited` 和 `balance`。原生客户端界面控制连接未提供，以上打包实现及本机 app-server 的 `CreditsSnapshot` 协议定义作为数据依据。网页保留百分比圆环，在展开详情中单独显示点数；余额四舍五入至最多两位小数并省略末尾的零，另覆盖零余额、无限额、暂缺、仅点数、稀疏通知、失败保留、完整读取清除和账户切换隔离。

账户额度浏览器回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/account-usage.mjs`。脚本注入隔离的 Pro 和 Plus 账户，核对默认圆环、账户行高度和单行重置信息，通过实际点击、Enter、空格、Esc 与外部点击验证详情收放；推进本地时钟并触发 30 秒倒计时回调，确认时间更新及后端请求数量。额度自动读取测试把 60 秒轮询缩短至 200 毫秒并按需启用，组件测试另行断言两个生产间隔。继续验证额度通知、接口失败、回到前台与设置页精简，覆盖浅色、深色、跟随系统深色、五档缩放、390px 窄屏和基础字号放大。截图及构建来源写入 `.cache/account-usage-compact-browser/after`。对照时将旧 `client/dist` 与 `build-info.json` 复制到 `.cache/account-usage-compact-before/`，分别命名为 `dist` 与 `build-info.json`，再以 `BROWSER_BEFORE=1` 运行同一脚本。

界面发生可见变化时，同步检查 README 和其他文档引用的仓库图片，在同一提交中更新受影响的截图。README 的界面截图维护在 `docs/images/`：`desktop-light.png` 与 `desktop-dark.png` 使用相同演示数据和 1440 × 900 的桌面视口，`mobile.png` 与 `mobile-sidebar.png` 使用 390 × 844 的手机视口及 2 倍设备像素比，分别展示对话与侧栏额度。执行 `npm run build` 后运行 `CHROME_PATH=/path/to/chromium node tests/browser/readme.mjs`，脚本在独立浏览器配置中使用隔离演示项目、Plus 双窗口额度和模拟消息，实际打开文件预览、切换主题与手机侧栏，并检查默认折叠圆环及展开后的单行重置信息。生成的截图默认写入 `docs/images/`，可通过 `BROWSER_OUTPUT_DIR` 指定其他目录；展开状态的检查截图、构建来源和检查记录写入 `.cache/readme-screenshots/after`。README 通过 `picture` 随阅读环境切换桌面截图，手机截图放在可展开区域；更新后运行 Markdown HTML 浏览器回归，检查实际渲染中的图片、相对链接、折叠区域及窄屏排版。

Markdown HTML 回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/markdown-html.mjs`。脚本使用当前 README、仓库内图片和隔离演示消息，通过程序实际消息区与文件面板验证 HTML 排版、折叠块、图标尺寸、本地候选图、深浅主题与系统主题、文内导航、大图预览及焦点恢复；另核对脚本过滤和窄屏布局。截图与构建来源写入 `.cache/markdown-html-browser/after`。对照时将旧 `client/dist` 和 `build-info.json` 复制到 `.cache/markdown-html-before/`，以 `BROWSER_BEFORE=1` 运行同一脚本。组件回归包含安全属性过滤、代码原文、相对路径、候选图失败与迟到读取、实际 README，以及既有的公式、Mermaid 和批注测试。

工具记录浏览器回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/tool-activities.mjs`。脚本在独立浏览器配置中注入 `tests/fixtures/tool-activities.mjs` 的模拟历史，验证图片直接显示、点击放大与焦点恢复、搜索结果仅显示标题链接（缺少标题时显示网址）、搜索记录折叠与恢复、可读网页操作和工具结果，以及深浅主题、80% 至 200% 缩放与窄屏；截图和构建来源写入 `.cache/tool-activities-browser/after`。搜索结果精简的修改前对照先把 `client/dist` 与 `build-info.json` 分别复制到 `.cache/tool-activities-before/dist` 与 `.cache/tool-activities-before/build-info.json`，再用 `BROWSER_BEFORE=1` 运行同一脚本，确认搜索结果仍显示摘要及内部字段，结果写入 `before` 目录。

文件打开回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/files.mjs`，本机需有支持 H.264 编码的 `ffmpeg`。脚本生成临时音视频、PDF、BMP 和二进制样本，注入隔离的模拟历史，实际点击并验证播放、进度跳转、媒体切换后的资源清理、图片与 PDF 预览、文件下载字节、文本编辑和失败重试，覆盖深浅主题与窄屏。截图、下载样本和构建来源保存在 `.cache/file-preview-browser/after`。对照时将旧构建及来源复制到 `.cache/file-preview-before/dist` 与 `.cache/file-preview-before/build-info.json`，以 `BROWSER_BEFORE=1` 分别记录音频的二进制提示与 PDF 被当作源码显示的结果。`server/tests/file-content.test.mjs` 覆盖 MIME、附件文件名、原始字节、Range、大文件及取消读取；桥接测试验证 HTTPS 路由，文件面板组件测试覆盖类型切换、保存保护、草稿与迟到读取隔离。

文件详情布局回归同时检查面板延伸到工作区底部、桌面输入框避让、折叠后恢复全宽，以及下载图标的位置、可访问名称和实际下载。深浅主题与 80%、100%、125%、150%、200% 缩放检查记录在 `.cache/file-layout-verified/`，其中 `pdf-chrome.png` 使用完整 Chromium 验证内置 PDF 阅读器；本次客户端对照以使用者提供的桌面截图为视觉依据；界面工具未提供可操作的客户端窗口，本机可取得的 Codex VS Code 客户端版本为 `26.1021.22027`，其资源位于扩展的 `webview/assets/`，桌面客户端布局的源码核对仍需对应安装资源。

单独验证发行包时执行：

```bash
npm run test:package
```

该测试在临时 npm prefix 中全局安装打包产物，检查命令入口、静态资源、构建来源、用户配置和服务生成。后端与服务管理命令使用模拟实现。安装优先复用 npm 缓存，缺少包元数据或依赖时访问配置的 registry，因此执行环境需要相应缓存或网络连接。

文件引用与批注展示回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium USER_CONTEXT=1 BROWSER_OUTPUT_DIR=.cache/user-message-context/after node tests/browser/annotations.mjs`。脚本使用隔离模拟历史，验证目录与文件引用、目录定位及子文件打开、批注原文收放、文件打开、原位编辑与取消、移除引用、批注修改及正文引用提交、刷新，以及深浅主题、80% 至 200% 缩放和窄屏。旧构建通过 `BROWSER_BUILD_DIR` 与 `BROWSER_BUILD_INFO` 指定，以 `BROWSER_BEFORE=1` 复现引用说明外露和编辑时批注协议进入输入框；截图与构建记录写入指定目录。目录跳转的修改前对照使用 `REFERENCE_NAVIGATION_BEFORE=1` 及旧构建，实际点击目录引用后确认面板保持折叠。单元与组件检查覆盖完整封装解析、普通文本保留、批注来源、编辑去重及失败重试，以及目录切换的未保存编辑确认、读取失败、目录与文件的迟到响应隔离。

文件引用的原生行为对照使用本机 Codex VS Code 客户端 `26.1021.22027` 的打包资源：`app-initial` 中的 `Ht`、`Ut` 与 `Sn` 分离上下文和用户请求；`src` 中的 `Su`、`Cu` 恢复文件引用，提交时生成文件上下文并保留正文；`comment-editor` 保留引用标签和路径，并在编辑模式转换时恢复。实际客户端界面控制连接不可用时，以这些实现作为行为证据，客户端运行界面的视觉对照另行记录。提取资源与查验记录仅保存在 `.cache/client-inspection/`。

右侧详情隔离回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium CONTEXT_RESET=1 BROWSER_OUTPUT_DIR=.cache/context-reset/after node tests/browser/annotations.mjs`。脚本以隔离 WebSocket 历史和独立浏览器配置，实际打开文件差异与变更面板并点击新建，检查默认收起、重新展开的概览、文件列表、深浅主题和手机布局。对照构建及构建信息分别保存到 `.cache/context-reset-before/dist` 与 `.cache/context-reset-before/build-info.json`，通过 `BROWSER_BEFORE=1`、`BROWSER_BUILD_DIR` 和 `BROWSER_BUILD_INFO` 指定并运行对照；截图和构建来源写入指定目录。组件回归补充文件、变更、子代理与待打开文件的清理，以及原对话未保存文件的恢复。

## 子代理消息回归

子代理主代理消息回归先执行 `npm run build`，再运行 `CHROME_PATH=/path/to/chromium node tests/browser/subagent-messages.mjs`。脚本使用隔离模拟后端，实际打开子代理详情，验证初始任务的位置、发送者标注、后续消息自动补齐、刷新去重、只读行为及桌面深浅主题和手机布局。旧构建和构建信息分别保存在 `.cache/subagent-messages-before/dist` 与 `.cache/subagent-messages-before/build-info.json`，使用 `BROWSER_BEFORE=1` 复现只有子代理回复的状态；截图及来源保存在 `.cache/subagent-messages-browser/`。服务端测试使用临时 rollout，覆盖调用与接收者核对、轮次定位、其他代理隔离、未接收消息和写入中的尾行；组件测试覆盖实时补齐及切换隔离。

加密消息回归在上述浏览器命令前增加 `BROWSER_ENCRYPTED=1`，使用临时父子 rollout 和真实桥接读取函数生成消息，检查加密状态、消息顺序、刷新、后续明文与深浅主题及手机布局。截图和构建来源写入 `.cache/subagent-encryption-browser/after/`。将对照读取模块保存到 `.cache/subagent-encryption-before/agent-messages.mjs`，再增加 `BROWSER_CIPHERTEXT_BEFORE=1` 运行对照。测试数据均为人工构造的记录；加密状态的单元回归同时覆盖结构化标记、非固定前缀、重复发送和其他发送者隔离。

等待接收的加密消息回归使用 `BROWSER_QUEUED_ENCRYPTED=1`，临时父记录包含已接收的初始任务和已发送的加密补充消息，子记录只包含初始任务，验证接收记录落盘前的状态及刷新后的持续隐藏。截图及构建来源保存在 `.cache/subagent-queued-browser/after/`。对照时将读取模块保存到 `.cache/subagent-queued-before/agent-messages.mjs`，增加 `BROWSER_CIPHERTEXT_BEFORE=1` 运行对照。`server/tests/agent-messages-queued.test.mjs` 覆盖接收前后、重复消息、带与不带填充的完整封包、普通前缀文字、引用封包的正文和无效封包；封包结构依据 [Fernet 规范](https://github.com/fernet/spec/blob/master/Spec.md)。

## Mermaid 图表回归

Mermaid 回归先执行 `npm run build`，再运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/mermaid.mjs`。使用隔离的后端历史与文件正文，在真实消息区和 Markdown 文件预览中绘制长流程图、短流程图及中文时序图；核对紧凑字号、长图展开与收起、完整高度、方向切换、原始源码保留，以及按钮、键盘和 Ctrl+滚轮缩放与复位。深浅主题、390px 窄屏及 80% 至 200% 的实际浏览器缩放均检查页面边界。截图、尺寸记录及构建来源保存在 `.cache/mermaid-size-browser/after`。将对照构建与来源复制到 `.cache/mermaid-size-before/dist` 和 `build-info.json` 后，使用 `BROWSER_BEFORE=1` 记录对照。

## 网页交互终端回归

网页手动终端通过独立的 `lan/terminal/*` 接口进入宿主工作区，由 node-pty 持有进程；模型后端、原生命令与后台任务分别按各自所有者维护。`node --test server/tests/web-terminals.test.mjs server/tests/backend-native-workspace-routing.test.mjs` 使用真实 PTY 和模拟后端，核对 Codex 与 Claude Code 标识均进入同一工作区、后端离线时仍可使用终端、连续创建五个、前台进程切换、单独结束及原生工作区路由。组件回归覆盖名称与图标更新、切换复用实例、启动目录隔离、面板开关与选中项恢复、后台目录退出隔离、Ctrl+D 及当前目录最后退出后的收起。`client/tests/terminal-workspace.test.js` 检查完整路径、中文目录及路径规范化，同目录切换后端和不同目录分别验证。

构建完成后运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/terminal.mjs`。浏览器使用临时目录、真实 zsh 和 Python、隔离账户与模拟目录请求，验证五终端、zsh → Python → zsh、不同文件夹对话的隔离及返回恢复、同文件夹对话共用、列表拖动与键盘调宽、面板上边缘拖动调高、尺寸隐藏与刷新恢复、拖动期间卸载清理、双击复位、隐藏与刷新恢复、深浅主题、窄屏侧栏收放，以及 80%、125%、150%、200% 实际页面缩放和 DPR。测试环境需安装 zsh 与 Python。截图和构建来源写入 `.cache/terminal-appearance/after`；旧构建通过 `BROWSER_BEFORE=1 UI_BUILD_DIR=/path/to/dist UI_BUILD_INFO=/path/to/build-info.json BROWSER_OUTPUT_DIR=/path/to/before` 生成修改前对照。临时浏览器配置和 PTY 在退出时清理。

## 浏览器专项回归

### 消息区滚动

构建后运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/conversation-width.mjs`。隔离对话包含普通及超宽行内公式、块公式、代码块与表格。脚本模拟手机触控，核对普通公式随正文排版、宽内容可局部横向滚动，并在聊天和文件预览中滚动浏览超高公式及后续正文。检查覆盖深浅主题、窄屏侧栏收放与焦点，以及五档浏览器页面缩放。截图和测量结果保存在 `.cache/conversation-width/after`，可用 `BROWSER_BEFORE=1 BROWSER_BUILD_DIR=/path/to/previous/dist` 对照整页仍可横向滚动的构建。

### 活动对话恢复

构建后使用相同浏览器环境变量运行 `node tests/browser/active-turn-recovery.mjs`。隔离会话核对切回活动对话时补齐先前正文、读取期间及之后的增量连续显示，以及后台续跑中首次补充同时出现在独立气泡与工作过程的提交位置。截图位于 `.cache/active-turn-recovery/browser`。桥接回归覆盖快照按对话隔离及完成后清理。

### 对话完成通知回归

执行 `npm run build` 后，使用 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/completion-notifications.mjs`。脚本使用独立浏览器上下文、模拟轮次及真实 Service Worker 和 IndexedDB，检查默认开启、手动关闭后的刷新恢复、待授权入口及主动授权、正常状态省略重复文案、后台完成、不同对话标题、跨页面原子去重、历史与刷新重连、开关同步及关闭期间的异步取消、失败与中断、存储失败、权限撤销、不支持的环境、通知消息跳转和新页面目标恢复。通知的原生显示接口保留真实调用，并记录实际调用数量，避免同一 tag 替换掩盖重复提醒。截图及构建来源保存在 `.cache/completion-notifications`，包含深浅主题、窄屏和 80%～200% 缩放。可设置 `HEADED=1` 在可用桌面或 Xvfb 中运行；系统横幅展示以浏览器及系统通知设置为准。

`client/tests/notifications.test.js` 验证应用层的授权、用户隔离、历史过滤、搜索列表外标题读取和生命周期清理，`client/tests/notification-worker.test.js` 验证点击时聚焦原窗口及窗口关闭后的打开目标。发行包回归检查 Worker 的交付清单及实际 HTTPS 路由。

### 登录与证书

`server/tests/auth.test.mjs` 通过临时 `CLAUDEX_WEB_CONFIG_DIR`、实际 TLS/WSS 服务及模拟 PAM 验证程序覆盖未登录访问、跨站请求、旧会话与退出、限流、维护连接及后台任务保护。双重验证回归覆盖 CLI 在线绑定、按名称登录、动态码防重放隔离、重启和单独撤销会话。`server/tests/auth-totp.test.mjs` 覆盖旧库迁移、关闭状态及最后一个绑定的撤销。测试凭据来自隔离夹具。`server/tests/tls.test.mjs` 检查证书并发生成、重复启动、权限与自定义证书；`server/tests/dev-https.test.mjs` 验证域名证书在本机 HTTPS/WSS 代理中的证书校验、Cookie 与来源转发。

浏览器回归使用 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/auth.mjs`，在生产构建和临时模拟后端上实际填写密码和动态码，检查首次绑定步骤、设置中的状态和折叠帮助，以及刷新、跨标签页退出、草稿恢复、过期、证书下载、设备安装指引、关于页隐藏开发标记、深浅主题及手机布局。截图及构建信息保存在 `.cache/auth-browser`。

构建完成后，使用同样的环境变量运行 `node tests/browser/p2p-settings.mjs`。回归在隔离浏览器和模拟授权服务中检查「连接与登录」的启停、状态读取失败重试、生成失败后的名称保留、剪贴板、撤销确认与刷新恢复。使用实际 80%～200% 页面缩放检查深浅主题与窄屏的操作边界和侧栏焦点，截图和测量结果保存在 `.cache/p2p-settings-browser`。

`server/tests/p2p-*.test.mjs` 覆盖回环命令行、授权持久化、真实 WebRTC 协商与撤销、登录前后的 RPC 与文件权限、跨链接会话隔离，以及文件 Range 和流式读取。构建后用与登录回归相同的浏览器环境变量运行 `node tests/browser/p2p-auth.mjs`，在隔离配置目录和模拟 OpenTunnel 上使用真实 WebRTC，检查在线添加验证器后的名称字段、默认和命名验证器的登录、错误密码、刷新、跨标签页恢复与退出、浏览器重开、链接隔离和撤销，并验收深浅主题、窄屏及 80%～200% 页面缩放。截图保存在 `.cache/p2p-auth-browser`。公共入口可用性需另行实测。

Ubuntu 安装指引回归在设备选择器中实际切换 Ubuntu，检查 DER 到 PEM 转换、系统安装命令及 Chrome / Chromium 和 Firefox 导入说明，保存桌面深浅主题、手机与 80% 至 200% 缩放截图。

### Markdown 富文本输入回归

输入框采用直接编辑排版正文的交互，持久化与提交使用 Markdown。执行 `npm run build` 后，使用 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/markdown-composer.mjs` 验证生产构建。脚本使用隔离模拟后端和独立浏览器上下文，检查双美元符号公式的同段渲染、单美元符号普通文本、闭合前源码、源码重入及撤销重做；同时检查延迟加载期间的文本及选区恢复、快速切换对话后的实例隔离、正文及列表的完整边界、点击与方向键定位、撤销重做、滚动后继续输入、原生光标、连续换行自动增高及可用空间边界、混合块在正文中间粘贴及选区替换后的顺序、光标与整次撤销、代码续写、公共手柄拖动及展开收起、放大时底部输入区的轮廓与尺寸保留、只读预览与编辑器节点隔离、编辑区滚轮上下滚动、混合 Markdown 粘贴、表格直接编辑、任务复选框、公式、脚注、代码与 HTML 源码保留、草稿、发送及快捷建议，并覆盖深浅主题、80%～200% 缩放和窄屏。截图、结果和构建来源保存在 `.cache/markdown-composer`。组件回归使用文本输入适配，实际富文本行为由浏览器回归覆盖；发行包回归验证编辑器分块的安装与资源响应，浏览器回归拦截外站请求。

使用相同环境变量运行 `tests/browser/markdown-typing.mjs`，验证逐字键入、整段插入、粘贴和中文组合输入自动排版。覆盖列表内公式 `- $$x_{t+1}=x_{t}+dx$$`、标题、强调、链接、任务列表、表格分隔行及代码围栏进出，同时核对实际可见排版、表格光标和 Markdown 草稿。证据保存在 `.cache/markdown-typing/after`。

`markdown-composer.mjs` 的剪贴板回归覆盖代码编辑器语言信息、单行代码在段落中插入和续写、一次撤销、网页行内代码及多行带语言围栏。检查编辑区域的原生节点、Markdown 草稿和提交内容，并保存行内粘贴截图。

`tests/browser/code-line-paste.mjs` 使用相同环境变量验证单行直接复制、手动选中复制、纯文本剪贴板及多行片段。多行在列表项内保持原有上下边界和插入位置，候选查询在隔离工作区运行 `rg`，服务端回归另覆盖首尾截断、两行选区、完整匹配优先及超额候选，核对文件行号、预览、重复粘贴共用单次查找及标签、最后一处撤销或删除时移除标签、重做、对话切换恢复及发送后的代码块。证据保存在 `.cache/code-line-paste/sources`。

链接续写回归使用相同环境变量运行 `tests/browser/composer-links.mjs`，通过实际键盘及粘贴事件验证网址、Markdown 链接和自动链接末尾的空格及正文留在链接之外，检查链接内部编辑、撤销和实际提交内容，保存深浅主题及窄屏截图。结果及构建来源写入 `.cache/composer-links/after`；对照时使用 `BROWSER_BEFORE=1` 记录格式延续问题，证据写入 `before` 目录。

附件草稿回归先执行 `npm run build`，再使用相同环境变量运行 `tests/browser/attachment-drafts.mjs`。脚本在独立浏览器上下文中同时上传生成的测试 PNG 和文本文件，通过侧栏切换到已有对话，再通过新建入口返回，检查文字、图片原始尺寸、文件附件、对话隔离和移除后的状态，覆盖桌面、窄屏及深浅主题。截图和结果保存在 `.cache/attachment-drafts/after`；通过 `BROWSER_BEFORE=1` 与 `BROWSER_BUILD_DIR` 指定旧构建，复现文字保留而附件消失，保存至同目录的 `before`。组件回归另覆盖图片及文件读取期间切换、首次创建对话的草稿迁移、发送失败重试、实际发送的文件正文，以及发送成功后保留等待期间新增的附件。

客户端交互的本机实现参考为 Codex 26.1007.21434，查验来源是 `/usr/lib/chatgpt/resources/app.asar` 的 `package.json`、`webview/assets/app-initial-ed5807835d97.js`、`app-primary-f49030709665.js` 和 `app-shared-2d77298f0100.js`。已核对 ProseMirror 编辑区、Markdown 解析与输入规则，以及 `getPersistedText`、`setPromptText` 的草稿读写流程。网页按直接编辑排版正文的产品要求，使用 Milkdown/ProseMirror 提供文档编辑与 Markdown 输入规则，并将输入语法范围明确为 CommonMark、GFM 和公式，Mermaid 与 HTML 保留源码。

### 原消息编辑回归

挂载与文件引用回归在构建后执行 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/message-editing-mount.mjs`。脚本使用仅含 Markdown 文件引用的单条用户消息、隔离模拟历史及真实 Chromium 编辑器，验证点击编辑、取消重开、引用保留、长正文内部滚动、底部草稿和高度偏好隔离、Ctrl+Enter 提交及刷新后再次编辑。通过 Chromium 设置执行桌面与窄屏、深浅主题及 80%、100%、125%、150%、200% 实际页面缩放，并核对 DPR 和视口。证据位于 `.cache/message-editing-mount/after`；对照时将 `client/dist` 和 `build-info.json` 保存到 `.cache/message-editing-mount/before`，设置 `EDIT_MOUNT_BEFORE=1` 运行对照。此回归直接挂载实际文档编辑器，组件测试中的文本框替身继续验证编辑用例。

执行 `npm run build` 后，使用 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/message-editing.mjs` 验证原地编辑。脚本使用生产构建、独立浏览器上下文与持久化的模拟历史，检查与底部输入框一致的背景、边框、阴影和聚焦反馈、主操作按钮配色、两行固定高度、紧凑宽度、长文本内部滚动及按钮位置稳定、铅笔图标、取消、Enter 换行、Ctrl+Enter 发送、文件引用、回退和发送失败重试、底部草稿隔离、刷新后的替换结果及切换对话时的迟到响应，覆盖深浅主题、80% 至 200% 缩放与窄屏。截图及构建来源保存在 `.cache/message-editing-browser/`。通过 `BROWSER_BEFORE=1`、`BROWSER_BUILD_DIR` 和 `BROWSER_BUILD_INFO` 指定隔离的旧构建及来源，复现恢复图标、回填底部输入和覆盖草稿，证据保存在 `.cache/message-editing-before-browser/`。领域与组件回归另覆盖完整轮次分页、旧接口兼容、运行状态、过期编辑、批注及附件独立性。

客户端对照来自本机 Codex VS Code 扩展 `26.1021.22027` 的 `webview/assets/user-message-d77a1f7e2581.js`：消息组件在原位置切换编辑表单，包含独立正文、取消和发送操作；`local-conversation-thread-a37d62aef644.js` 将编辑动作提交到 `src-622b307a9baf.js` 的历史编辑流程，校验最近用户消息与活动轮次，调用 `thread/revert` 或 `thread/rollback` 后启动新轮次。本机后端 `codex-cli 0.162.1` 生成的协议确认 `thread/revert` 以 `beforeTurnId` 替换持久历史，并通过 `thread/reverted` 通知其他页面。客户端界面控制连接超时，交互证据使用本机打包实现；提取资源仅保存在忽略目录。

编辑框尺寸对照可使用 `EDIT_SIZE_BEFORE=1`，并通过 `BROWSER_BUILD_DIR` 与 `BROWSER_BUILD_INFO` 指定对照构建和来源；结果保存在 `.cache/message-edit-size-before/browser/`。

编辑框样式对照使用 `EDIT_STYLE_BEFORE=1` 并指定旧构建及来源，记录实际输入区与消息编辑框的背景、聚焦和失焦边框、阴影及发送按钮配色；结果保存在 `.cache/message-edit-style-before/browser/`。当前构建同时比较浅色、深色及跟随系统深色，确认两处输入区域使用一致的视觉反馈。

### 计划模式回归

执行 `npm run build` 后，使用 `CHROME_PATH=/path/to/chromium PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/plans.mjs`。脚本使用生产构建和隔离历史，验证默认部分预览、点击与键盘展开收起、刷新恢复默认折叠、修改意见使用计划模式、批准以默认模式提交完整方案、失败重试、刷新及草稿保留；深浅主题覆盖 80%、100%、125%、150% 和 200% 缩放，并检查窄屏点击区域和横向溢出。截图、发送参数和构建来源保存在 `.cache/plans-browser`。`BROWSER_BEFORE=1 BROWSER_BUILD_DIR=/path/to/old/dist` 可在同一夹具中核对旧版正文折叠与缺少批准入口，证据保存在 `.cache/plans-before/browser`。领域与组件回归补充流式更新、重复点击、失败轮次、只读展示和切换对话后的迟到结果。

客户端行为核对依据为 Codex VS Code 扩展 `26.1021.22027` 的本机打包资源：`webview/assets/src-622b307a9baf.js` 中的 `item/plan/delta` 分派和计划执行状态，以及 `pending-request-item-panel-d13bffae20bf.js` 中的批准与修改处理。客户端批准选择默认模式并提交完整方案，修改意见继续使用计划模式；网页沿用这一提交语义，并依据 `plan-summary-item-content-27c95dedbba3.js` 的正文预览与展开交互，主对话调用在 `local-conversation-turn-6d79d254d102.js` 显式传入 `defaultCollapsed: true`；预览正文高度为 320 像素，底部渐隐并提供展开按钮。网页以字体相对尺寸实现同一预览高度，并在提交成功后更新模式，使失败请求保留重试状态。

### 后端归属图标

后端设置、对话顶部、侧栏和对话切换器共用后端标识组件。CSS 蒙版以主题正文颜色呈现原始图形。同一界面的标识以相同视觉大小居中显示，验收以图案实际绘制范围为准。

Codex 使用 `client/src/assets/openai.svg` 中的黑色 Blossom 图形，保留原始轮廓，将 `viewBox` 收紧至图形外围，以匹配 Claude Code 标识的绘制范围。图形取自 OpenAI 官方品牌素材，标识归 OpenAI 所有。[OpenAI 品牌素材](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip) · [OpenAI 品牌指南](https://openai.com/brand/)

Claude Code 使用 `client/src/assets/claude.svg` 中取自官方网站页首标志的独立图形路径，标识归 Anthropic 所有。Claudex Web 产品图标使用 `claudex-web.svg`。[Claude 官方网站](https://claude.com/)

生产构建后运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/settings-navigation.mjs`。隔离浏览器验证五个设置入口、更新直达、焦点返回、跨页草稿与在途保存、P2P 轮询暂停，以及真实侧栏中的标识绘制范围。桌面和窄屏分别覆盖深浅主题与 80% 至 200% 实际页面缩放，截图保存在 `.cache/settings-navigation/`。

双后端回退对照记录见[双后端回归审查](architecture/backend-regressions.md)。`tests/browser/backend-regressions.mjs` 使用生产构建、独立浏览器和隔离传输验证旧未分类目录、用户消息 Markdown、引用键盘打开、Claude 内部消息来源、主题、缩放与窄屏；通过 `CHROME_PATH`、`PLAYWRIGHT_MODULE` 配置浏览器工具。`tests/integration/claude-message-provenance.mjs` 通过真实 SDK 读取临时原生 JSONL，核对来源字段保留与用户轮次归属。

前端外壳与顶部切换回归使用相同浏览器环境变量运行 `tests/browser/backend-interactions.mjs`。脚本核对文件夹与对话的分组、顺序、选择、草稿恢复及工作目录选择器，并在深浅主题、宽屏横向、宽屏竖向和手机窄屏的 80% 至 200% 实际页面缩放下检查侧栏、切换菜单与搜索弹窗。侧栏场景覆盖竖屏首次载入、转向、手动收放、跨断点状态及焦点返回。其他键盘场景包括弹窗聚焦与返回、尺寸记忆与复位，以及对话操作菜单关闭与背景点击。截图与结果位于 `.cache/backend-interactions/dual/`。

后端启停回归执行 `npm run build` 后运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/backend-toggle.mjs`。脚本在隔离传输中保留 Codex 与 Claude 对话，实际在设置中停用后端，核对所属对话立即从侧栏移除、正在查看的对话回到新对话、重新启用后恢复，并确认过程中未刷新页面；截图覆盖深浅主题与手机侧栏，保存在 `.cache/backend-toggle/after`。旧构建保存在 `.cache/backend-toggle-before/dist`，通过 `UI_BUILD_DIR` 与 `UI_BEFORE=1` 复现对话保留到刷新的状态，截图写入 `.cache/backend-toggle/before`。

### 自定义供应商模型参数回归

执行 `npm run build` 后运行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/provider-model-aliases.mjs`。回归使用含十个模型的隔离供应商，验证行尾操作、连接字段的标签和控件同行及清除入口位置、凭据保留与替换及清除、模型下拉切换、显示别名和上下文容量的标签及输入框四项同行、思考强度点选和键盘勾选、草稿隔离、失败重试及重新编辑恢复。布局检查覆盖深浅主题、桌面及窄屏的 80% 至 200% 实际浏览器缩放。截图保存在 `.cache/provider-model-aliases/dual`。服务端配置回归验证别名持久恢复、无效模型拒绝及移除模型后清理别名。

### 默认供应商回归

默认供应商统一在 `server/src/backends/provider-presets.mjs` 登记稳定标识、协议、地址与模型，凭据沿用受限的供应商配置存储。`server/tests/provider-presets.test.mjs` 使用临时配置验证空凭据停用、填写启用、持久恢复、运行时环境、清空撤销及公开响应隐藏凭据。

构建后执行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/provider-presets.mjs`，通过隔离传输验证默认项展示、仅提供 Key 编辑、Key 保存与清空、模型菜单同步、深浅主题、80%、100%、125%、150% 与 200% 实际浏览器页面缩放及窄屏。截图保存在 `.cache/provider-presets/dual`。缩放通过隔离扩展调用浏览器页面缩放接口，并核对实际缩放值、DPR 与视口。真实 DeepSeek 推理调用需使用显式提供的有效凭据。

默认供应商品牌图标必须在统一定义中提供 `icon` 标识，对应 SVG 位于 `client/src/assets/providers`，配置测试核对每个默认供应商的图标存在及默认项置顶顺序。DeepSeek 图标原样取自 [DeepSeek 官方品牌素材 ICON.svg](https://github.com/deepseek-ai/awesome-deepseek-integration/blob/main/docs/_logo%20svg/ICON.svg)，标识归 DeepSeek 所有，使用遵循该目录的品牌素材规范。浏览器回归核对实际品牌图标加载与列表顺序。

### 窗口尺寸回归

执行 `npm run build` 后，使用 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/surface-resize.mjs`。回归在生产构建、模拟后端和独立浏览器数据目录中验证公共弹窗、文件详情、图片预览和批注浮窗的拖动、键盘、双击复位、触控、失焦释放、关闭重开、刷新恢复及编辑内容保留；同时核对详情宽度与底部输入区避让一致。深浅主题、桌面和窄屏覆盖 80%、100%、125%、150% 与 200% 实际浏览器页面缩放，检查 DPR、窗口与关闭按钮边界。结果与截图保存在 `.cache/surface-resize/`。项目侧栏和终端保持独立的尺寸控件，分别沿用侧栏和终端回归。测试无需模型调用，浏览器进程和临时配置在结束时清理。

尺寸手柄状态由 `tests/browser/resize-handle-states.mjs` 统一验证。窗口回归和终端回归分别对侧栏、终端高度、终端列表、文件详情、弹窗、图片、批注和多行表单检查默认、悬停、键盘聚焦及指针捕获期间的实际计算样式，确认标记尺寸、透明操作区、拖动高亮与释放状态；同时执行真实拖动及键盘调整，检查字段内容和复位。终端回归继续使用隔离的真实 zsh/Python 进程。通过 `BROWSER_OUTPUT_DIR` 选择证据目录，`RESIZE_STYLE_BEFORE=1` 配合 `BROWSER_BUILD_DIR`（窗口）或 `UI_BUILD_DIR`（终端）可采集统一前构建的状态对照。

对话拖拽回归使用 `THREAD_FOLDER_DRAG=1 CHROME_PATH=/path/to/chromium node tests/browser/project-pins.mjs`，验证真实鼠标拖起、目标高亮、保存、刷新恢复、未分类及深浅主题，证据保存到 `.cache/project-pins-browser/after`。`node tests/integration/codex-folder-native.mjs` 使用隔离历史验证原生目录恢复，模型请求为零；`node tests/integration/thread-folder-native.mjs` 使用真实 Claude CLI 与本机模拟模型服务验证跨目录继续、旧正文及目标 AGENTS 指令，全部数据位于临时目录。网页项目以单个文件夹为归属边界。

批注换行边界回归在构建后执行 `ANNOTATION_WRAPPING=1 CHROME_PATH=/path/to/chromium node tests/browser/annotations.mjs`，使用隔离浏览器与模拟历史，逐字覆盖窄字符、中文长文、深浅主题及删除后收起。结果保存在 `.cache/annotations-browser/wrapping-results.json`。

### 本地思考内容翻译验证

中途进入运行中会话的回归执行 `TRANSLATION_TEST_MODEL_DIR=/path/to/installed/models PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/translation-active-history.mjs`。脚本使用生产构建、临时配置与隔离历史，保留原生历史摘要缺少状态字段的结构，实际调用本地 CPU 引擎，验证旧摘要翻译、当前摘要等待完成、原译文切换、刷新缓存、深浅主题、窄屏及 80% 至 200% 实际页面缩放。证据保存在 `.cache/translation-active-history/after`。对照时将 `client/dist` 和 `build-info.json` 分别复制到 `.cache/translation-active-history/before/dist` 和 `build-info.json`，再加 `BROWSER_BEFORE=1` 运行。测试恢复页面缩放并清理临时配置与浏览器；

构建后执行 `TRANSLATION_TEST_MODEL_DIR=/path/to/installed/models PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/thinking-translation.mjs`。脚本使用独立浏览器、临时配置和模拟对话，实际调用本地 CPU 引擎，验证默认关闭、完整消息触发、等待原文、Markdown 文字提取、原译文切换及关闭恢复原文，覆盖深浅主题、桌面与窄屏、80% 至 200% 实际浏览器缩放。已安装模型目录由运行者提供，截图和结果保存在 `.cache/thinking-translation/`，测试结束后清理浏览器与临时配置。

异步回复收纳回归在构建后执行 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/async-replies.mjs`。夹具保留真实 Codex 消息的 `delivery: async` 与 `phase: final_answer` 组合，检查中途回复在折叠时隐藏、展开后完整可读、连续补充保留一个工作过程及原展开状态、流式投递、最终回答操作与草稿；刷新、深浅主题、桌面与窄屏、80% 至 200% 实际页面缩放采用相同断言。截图及结果保存在 `.cache/async-replies/after`。`BROWSER_BEFORE=1 BROWSER_BUILD_DIR=/path/to/previous/dist` 使用旧构建复现外露；`CONVERSATION_NATIVE_FILE=/path/to/turn.json` 可重放只读导出的真实轮次，原生记录保存在 Git 忽略目录且不调用模型。测试结束恢复缩放并清理独立浏览器配置。

运行状态渲染回归使用 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_PATH=/path/to/chromium node tests/browser/status-rendering.mjs`，通过隔离后端和生产构建验证运行、展开、完成、草稿保留及计时更新，并记录 3.1 秒稳定内容期间的绘制帧数与活动动画。证据写入 `.cache/status-rendering/after`。旧构建放入 `.cache/status-rendering/before/dist`，设置 `BROWSER_BEFORE=1` 复现循环动画引起的逐帧绘制。该回归关闭 GPU，验证浏览器绘制调度；实际 GPU 占用另通过桌面静置采样核对。

### 目标交互回归

本机客户端对照为 Codex 26.1007.21434 的 `/usr/lib/chatgpt/resources/app.asar`：`app-primary-f49030709665.js` 包含目标输入指示、常驻摘要、替换确认及操作；`thread-goal-side-panel-content-3f8ca4dc6e07.js` 包含侧边 Markdown 编辑、还原、保存与更新时间，`toolbar-row-123131d0eebd.js` 确认更新时间与操作同排的紧凑布局；`app-initial-ed5807835d97.js` 包含原生目标设置、状态更新及清除调用。客户端窗口控制超时，行为依据来自上述可取得的打包实现。提取资源保存在忽略目录 `.cache/goal-client`。

构建后运行 `CHROME_PATH=/path/to/chromium BROWSER_OUTPUT_DIR=.cache/goal-browser node tests/browser/commands.mjs`，使用生产构建及隔离模拟对话核对目标创建、暂停、恢复、侧边编辑、预算、深浅主题、窄屏及 80%～200% 实际浏览器缩放；通过 Chromium 设置页调整页面缩放并核对 DPR。目标控制器测试覆盖通知与迟到请求、重复提交、失败重试和替换确认。`node --import ./tests/helpers/test-console.mjs tests/integration/codex-native-goals.mjs` 使用临时原生目录验证真实 Codex 的暂停目标创建、读取、编辑、清除与通知，模型调用为零；Claude 原生执行验证使用同样预加载入口运行 `tests/integration/claude-native-goals.mjs`，接入本机模拟模型服务，核对原生目标评估及预算生命周期。右侧目标面板采用单行标题、紧凑工具栏与独立滚动正文，预算默认收起，展开后验证输入与保存。

## 从源码运行后台服务

在项目根目录执行：

```bash
npm run build
npm run service:install
npm run service:status
```

安装脚本创建用户级 `claudex-web.service`，直接运行当前项目中的桥接服务。已有 `codex-app-server.service` 保留代理、环境和启动设置；缺失时创建后端服务。被覆盖的网页服务配置备份到用户状态目录下的 `claudex-web/service-backups`。

每次交付先核对 `systemctl --user show claudex-web.service -p WorkingDirectory -p ExecStart -p DropInPaths` 指向本次使用的源码和构建。当工作区切换时，同步检查覆盖配置，保留服务环境和配置目录。构建后通过以下命令等待任务与上下文整理结束，再更新持久服务：

```bash
npm run service:restart-when-idle
```

有会话需要等待时，用用户级 `systemd-run` 托管等待命令，检查等待单元和日志，直到服务完成重启。由当前服务承载的开发对话也计入活跃轮次，结束该轮后由等待单元触发重启，再核验生效。确认任务与终端均已结束时，也可使用 `npm run service:restart`。终端状态和输出保存在桥接进程中，重启前应保护运行中的工作。

空闲判断只使用连接就绪状态、对话轮次与上下文整理占用。打开的网页终端与任务分别处理，等待程序只执行网页服务重启。日志在等待数量改变时更新，重启后检查 `/healthz` 并报告实际运行版本；自动化交付还需核对 `lan/state` 的所需接口。`server/tests/restart-when-idle.test.mjs` 在临时目录提供模拟 systemctl 与 HTTPS/WSS 服务，验证终端保持打开、任务和整理占用、等待期间新轮次、健康检查重试及重启失败，不操作真实服务。

源码部署与全局安装使用相同服务名，同一用户使用一套部署。从源码切换到全局包时，将项目 `.env` 中需要保留的配置迁移到用户配置目录，再按[发行包安装说明](deployment.md#安装发行包)更新服务。

重启后核对主进程 PID、启动时间、`/healthz` 的构建标识和实际前端资源，刷新浏览器即可调试。增加按需加载模块时，同时验证生产资源路由与发行包内的 JavaScript、CSS 分块。

## 打包与发布

项目通过 GitHub Release 分发预构建 npm 安装包。手动构建发行包时执行：

```bash
npm ci
npm run check
npm pack
```

`npm pack` 的 `prepack` 会重新构建网页并生成 `claudex-web-X.Y.Z.tgz`，其中 `X.Y.Z` 为根包版本。`package.json` 的 `files` 白名单包含命令行入口、前端构建资源、构建来源、桥接代码与运行脚本；开发源码、测试、聊天数据和实际环境配置在包外。运行依赖由目标机器上的 npm 安装。

正式版本、工作流、定时发布及 npm OIDC 发布见[版本管理](versioning.md)。发布准备时在实际标签的 `GITHUB_REF_NAME` 环境执行完整检查，版本测试的临时仓库显式使用对应标签。

## 构建来源

构建来源与运行版本核对见[版本管理](versioning.md#查看正在使用的版本)。
