export function backendFixture(data) {
  if (!data.retainStorageOnReload || !sessionStorage.backendFixtureInitialized)
    localStorage.clear();
  if (data.retainStorageOnReload)
    sessionStorage.backendFixtureInitialized = "1";
  localStorage.setItem("cx-current", "legacy");
  localStorage.setItem("cx-theme", JSON.stringify("light"));
  const threads = [
    {
      id: "legacy",
      name: "旧版未分类与 Markdown",
      cwd: "/native/claudex-web/workspaces/chat-ABC123",
      originator: "claudex_web",
      createdAt: 3,
    },
    {
      id: "desktop",
      name: "客户端未分类",
      cwd: "/documents/Codex/2026-11-06/notes",
      createdAt: 2,
    },
    {
      id: "backend:claude:fixture",
      name: "Claude 原生消息归属",
      cwd: "/demo/project",
      model: "sonnet",
      createdAt: 1,
    },
  ];
  const projectTurns = {};
  if (data.projectSwitcher) {
    localStorage.setItem(
      "cx-projects",
      JSON.stringify(["/demo/Empty", "/demo/project"]),
    );
    localStorage.setItem("cx-pins", JSON.stringify(["pinned-only"]));
    threads.push({
      id: "pinned-only",
      name: "仅有置顶对话的文件夹",
      cwd: "/demo/Pinned",
      createdAt: 0,
    });
    threads.push(
      {
        id: "project-running-first",
        name: "发送较早的进行中对话",
        cwd: "/demo/project",
        createdAt: 3,
      },
      {
        id: "project-running-latest",
        name: "发送较晚的进行中对话",
        cwd: "/demo/project",
        createdAt: 4,
      },
    );
    Object.assign(projectTurns, {
      "project-running-first": {
        id: "running-first",
        status: "inProgress",
        startedAt: 20,
      },
      "project-running-latest": {
        id: "running-latest",
        status: "inProgress",
        startedAt: 30,
      },
      "backend:claude:fixture": {
        id: "human",
        status: "completed",
        startedAt: 10,
        completedAt: 50,
      },
    });
  }
  const messages = {
    legacy: data.codexItems || [
      {
        id: "markdown-user",
        type: "userMessage",
        turnId: "legacy-turn",
        content: [
          { type: "text", text: data.markdown },
          {
            type: "text",
            text: "引用本机文件：/demo/notes.md\n请根据任务按需读取。",
          },
        ],
      },
    ],
    "backend:claude:fixture": data.claudeItems,
  };
  const backends = ["codex", "claude"].map((id) => ({
    id,
    type: id,
    name: id === "codex" ? "Codex" : "Claude Code",
    enabled: true,
    ready: true,
    installation: data.backendInstallations?.[id],
    ...data.backendSettings?.[id],
  }));
  if (data.nativeDelegation)
    backends.push({
      id: "agy",
      type: "agy",
      name: "Antigravity",
      enabled: false,
      ready: false,
      ...JSON.parse(sessionStorage.delegationSettings || "{}"),
    });
  const delegationModes = new Map();
  let providers =
    data.providers ||
    (data.providerModelNames
      ? [
          {
            id: "vendor",
            backendId: "claude",
            name: "示例供应商",
            baseUrl: "https://example.org",
            models: [
              "provider/team/very-long-custom-model-identifier-for-alias-testing",
            ],
            modelAliases: {},
          },
        ]
      : []);
  const backendIdOf = (id) =>
    id?.startsWith("backend:") ? id.split(":")[1] : "codex";
  const state = () => ({
    ready: backends.some((backend) => backend.ready),
    bridgeReady: true,
    nativeDelegation: data.nativeDelegation,
    backends,
    defaultBackendId:
      backends.find((backend) => backend.enabled)?.id || "codex",
    defaultCwd: "/demo/project",
    projectlessRoot: data.main
      ? "/native/claudex-web/workspaces"
      : "/web/workspaces",
    projectlessRoots: ["/web/workspaces", "/native/claudex-web/workspaces"],
    activeTurns: {
      ...data.activeTurns,
      ...Object.fromEntries(
        Object.entries(projectTurns)
          .filter(([, turn]) => turn.status === "inProgress")
          .map(([id, turn]) => [id, turn.id]),
      ),
    },
    executionStatuses: {},
    compactions: {},
    undoneFiles: [],
    questions: [],
    terminals: {},
  });
  window.fixtureRequests = [];
  window.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      window.backendSocket = this;
      setTimeout(
        () =>
          this.onmessage({
            data: JSON.stringify({ method: "lan/state", params: state() }),
          }),
        0,
      );
    }
    send(raw) {
      const m = JSON.parse(raw),
        p = m.params || {};
      window.fixtureRequests.push(m);
      if (!m.method) return;
      const thread = threads.find((t) => t.id === p.threadId);
      let result = { data: [] };
      if (m.method === "lan/backends/list") result = { backends };
      if (
        data.delegationDefaultPrompt &&
        m.method === "lan/backends/agy/role/save"
      ) {
        if (p.content === data.delegationDefaultPrompt)
          delete sessionStorage.delegationRole;
        else sessionStorage.delegationRole = p.content;
      }
      if (
        data.delegationDefaultPrompt &&
        m.method.startsWith("lan/backends/agy/role/")
      )
        result = {
          content:
            sessionStorage.delegationRole ?? data.delegationDefaultPrompt,
          defaultContent: data.delegationDefaultPrompt,
          customized: "delegationRole" in sessionStorage,
        };
      if (m.method === "lan/backends/save") {
        const backend = backends.find((b) => b.id === p.id);
        Object.assign(backend, p);
        if (data.nativeDelegation && p.delegates)
          sessionStorage.delegationSettings = JSON.stringify({
            delegates: p.delegates,
            delegationPrompts: p.delegationPrompts,
            delegationSourcePrompts: p.delegationSourcePrompts,
          });
        if (Object.hasOwn(p, "enabled")) backend.ready = p.enabled;
        this.emit("lan/state", state());
        result = { backends };
      }
      if (m.method === "lan/backends/versions") {
        this.emit("lan/state", state());
        result = { backends };
      }
      if (m.method === "lan/backends/install") {
        const backend = backends.find((b) => b.id === p.id);
        backend.installation = {
          installed: true,
          currentVersion: "2.1.318",
          latestVersion: "2.1.318",
          installing: false,
        };
        this.emit("lan/state", state());
        result = { backends };
      }
      if (m.method === "thread/list")
        result = {
          data: threads.filter((thread) =>
            backends.some(
              (backend) =>
                backend.enabled && backend.id === backendIdOf(thread.id),
            ),
          ),
        };
      if (m.method === "lan/projectless/read")
        result = { directories: { desktop: threads[1].cwd } };
      if (m.method === "lan/providers/list")
        result = {
          providers: providers.filter(
            (provider) => p.includeDisabled || provider.enabled !== false,
          ),
        };
      if (m.method === "lan/providers/remove") {
        providers = providers.filter((provider) => provider.id !== p.id);
        result = { providers };
      }
      if (m.method === "lan/providers/save") {
        const previous = providers.find((provider) => provider.id === p.id);
        providers = [
          {
            ...previous,
            ...p,
            ...(previous?.preset && {
              enabled: Boolean(p.apiKey?.trim()),
              hasApiKey: Boolean(p.apiKey?.trim()),
            }),
          },
          ...providers.filter((provider) => provider.id !== p.id),
        ];
        result = { providers };
      }
      if (m.method === "model/list")
        result = {
          data: [
            {
              id: p.backendId === "claude" ? "sonnet" : "gpt",
              model: p.backendId === "claude" ? "sonnet" : "gpt",
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "high",
            },
          ],
        };
      if (m.method === "model/list")
        result.data.push({
          id: "second",
          model: "second",
          displayName: "Second Model",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "high" },
          ],
          defaultReasoningEffort: "high",
        });
      if (m.method === "model/list" && p.backendId === "codex")
        result.data.push(...(data.codexModels || []));
      if (
        (data.providerModelNames || data.providers) &&
        m.method === "model/list" &&
        providers.some((provider) => provider.id === p.providerId)
      ) {
        const provider = providers.find(
          (provider) => provider.id === p.providerId,
        );
        result = {
          data: provider.models.map((model) => ({
            id: model,
            model,
            displayName: provider.modelAliases?.[model] || model,
            supportedReasoningEfforts: (
              provider.modelCapabilities?.[model]?.supportedEffortLevels || []
            ).map((reasoningEffort) => ({ reasoningEffort })),
          })),
        };
      }
      if (m.method === "fs/readDirectory")
        result = {
          entries: [{ fileName: "notes.md", isFile: true, isDirectory: false }],
        };
      if (m.method === "fs/readFile")
        result = { dataBase64: btoa("# Notes\n\nFile reference fixture.") };
      if (m.method === "config/read") result = { config: {} };
      const balance = data.providerBalances?.[p.providerId];
      if (m.method === "account/read")
        result = {
          account: balance
            ? {
                type: "provider",
                providerId: p.providerId,
                usageSupported: true,
              }
            : null,
        };
      if (m.method === "account/rateLimits/read" && balance)
        result = {
          rateLimits: {
            limitId: p.providerId,
            windows: [],
            balances: [balance],
            balanceAvailable: true,
          },
          providerId: p.providerId,
        };
      if (m.method.startsWith("lan/projectModels/")) result = { projects: {} };
      if (["thread/read", "thread/resume"].includes(m.method))
        result = {
          thread: {
            ...thread,
            delegationMode: delegationModes.get(p.threadId) === true,
          },
          cwd: thread.cwd,
          model: thread.model || "gpt",
        };
      if (m.method === "thread/items/list")
        result = {
          data: (messages[p.threadId] || []).toReversed().map((item) => ({
            turnId: item.turnId,
            item,
          })),
        };
      if (m.method === "lan/delegation/tasks") result = { items: [] };
      if (m.method === "lan/delegation/mode/set") {
        delegationModes.set(p.threadId, p.delegationMode);
        result = { delegationMode: p.delegationMode };
      }
      if (m.method === "lan/projectless/prepare" && data.nativeDelegation)
        result = {
          cwd: "/web/workspaces/delegation-fixture",
          root: "/web/workspaces",
        };
      if (m.method === "thread/start" && data.nativeDelegation)
        result = {
          thread: {
            id: "backend:claude:new-delegation",
            backendId: "claude",
            cwd: p.cwd,
            delegationMode: p.delegationMode === true,
          },
        };
      if (m.method === "turn/start" && data.nativeDelegation)
        result = {
          turn: {
            id: "delegation-browser-turn",
            status: "completed",
            items: [],
          },
        };
      if (m.method === "thread/backgroundTasks/list")
        result = { tasks: data.backgroundTasks?.[p.threadId] || [] };
      if (m.method === "thread/turns/list")
        result = {
          data: [
            {
              id:
                data.activeTurns?.[p.threadId] ||
                (p.threadId === "legacy" ? "legacy-turn" : "human"),
              status: data.activeTurns?.[p.threadId]
                ? "inProgress"
                : "completed",
              startedAt: data.turnStartedAt || 1,
              completedAt: data.activeTurns?.[p.threadId] ? null : 2,
              items: messages[p.threadId] || [],
            },
          ],
        };
      if (m.method === "thread/turns/list" && projectTurns[p.threadId])
        result = { data: [projectTurns[p.threadId]] };
      if (m.method === "skills/list")
        result = {
          data: [
            {
              cwd: p.cwd,
              skills: [
                {
                  name: "测试技能",
                  description: "交互对照技能",
                  path: "/demo/skill/SKILL.md",
                },
              ],
            },
          ],
        };
      setTimeout(
        () => this.onmessage({ data: JSON.stringify({ id: m.id, result }) }),
        0,
      );
    }
    setBackendInstallation(id, patch) {
      const backend = backends.find((backend) => backend.id === id);
      backend.installation = { ...backend.installation, ...patch };
      this.emit("lan/state", state());
    }
    setBackendReady(id, ready) {
      backends.find((backend) => backend.id === id).ready = ready;
      this.emit("lan/state", state());
    }
    emit(method, params) {
      if (method === "turn/completed" && projectTurns[params.threadId])
        projectTurns[params.threadId] = params.turn;
      this.onmessage({ data: JSON.stringify({ method, params }) });
    }
    close() {
      this.readyState = 3;
    }
  };
}
