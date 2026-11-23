// 同等历史和网络延迟隔离后端导航成本；慢辅助请求不参与正文与输入恢复。
export function backendSwitchPerformanceFixture() {
  localStorage.clear();
  localStorage.setItem("cx-projects", JSON.stringify(["/demo/switch"]));
  const ids = ["codex", "claude", "opencode"];
  const threads = ids.flatMap((backend, index) =>
    [0, 1].map((n) => ({
      id: backend === "codex" ? `codex-${n}` : `backend:${backend}:${n}`,
      name: `${backend} 对话 ${n}`,
      cwd: "/demo/switch",
      createdAt: 10 - index,
      completedAt: 20,
      model:
        backend === "opencode"
          ? "openai/gpt-6.2-sol"
          : backend === "claude"
            ? "sonnet"
            : "gpt-6.2-sol",
    })),
  );
  const entries = (thread) =>
    Array.from({ length: 12 }, (_, n) => [
      {
        turnId: `turn-${n}`,
        item: {
          id: `user-${n}`,
          type: "userMessage",
          content: [{ type: "text", text: `第 ${n + 1} 轮：检查对话切换` }],
        },
      },
      {
        turnId: `turn-${n}`,
        item: {
          id: `answer-${n}`,
          type: "agentMessage",
          phase: "final_answer",
          text: `### 第 ${n + 1} 轮结果\n\n保留历史正文、草稿和模型设置。\n\n${n === 11 ? `结束标记 ${thread.id}` : "已有内容。"}`,
        },
      },
    ]).flat();
  const state = (window.switchFixture = {
    threads,
    requests: [],
    measurements: [],
    slow: false,
    metadataDelay: 1800,
    longTasks: [],
  });
  new PerformanceObserver((list) =>
    state.longTasks.push(
      ...list
        .getEntries()
        .map((e) => ({ start: e.startTime, duration: e.duration })),
    ),
  ).observe({ type: "longtask" });
  state.begin = (id) => {
    state.pending = {
      id,
      started: performance.now(),
      firstPaint: null,
      ready: null,
    };
  };
  new MutationObserver(() => {
    const current = state.pending;
    if (!current || current.firstPaint !== null) return;
    if (
      ![...document.querySelectorAll(".assistant-message")].some((node) =>
        node.textContent.includes(`结束标记 ${current.id}`),
      )
    )
      return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (state.pending === current && current.firstPaint === null)
          current.firstPaint = performance.now() - current.started;
      }),
    );
  }).observe(document, { childList: true, subtree: true });
  window.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      setTimeout(
        () =>
          this.onmessage({
            data: JSON.stringify({
              method: "lan/state",
              params: {
                ready: true,
                bridgeReady: true,
                backends: ids.map((id) => ({
                  id,
                  type: id,
                  name: {
                    codex: "Codex",
                    claude: "Claude Code",
                    opencode: "OpenCode",
                  }[id],
                  enabled: true,
                  ready: true,
                })),
                defaultBackendId: "codex",
                defaultCwd: "/demo/switch",
                activeTurns: {},
                questions: [],
              },
            }),
          }),
        0,
      );
    }
    send(raw) {
      const { id, method, params: p = {} } = JSON.parse(raw);
      const start = performance.now();
      const record = { method, params: p, start };
      state.requests.push(record);
      const thread = threads.find((t) => t.id === p.threadId);
      let result = { data: [] };
      if (method === "thread/list")
        result = { data: threads, nextCursor: null };
      if (["thread/read", "thread/resume"].includes(method))
        result = {
          thread,
          model: thread.model,
          reasoningEffort: "high",
          serviceTier: null,
        };
      if (method === "thread/items/list")
        result = { data: entries(thread).toReversed(), nextCursor: null };
      if (method === "thread/turns/list")
        result = { data: [], nextCursor: null };
      if (method === "model/list") {
        const model = threads.find((t) => t.name.startsWith(p.backendId)).model;
        result = {
          data: [
            {
              id: model,
              model,
              displayName: model === "sonnet" ? "Sonnet" : "GPT-6.2-Sol",
              providerName: p.backendId === "claude" ? "Claude" : "ChatGPT",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            },
          ],
        };
      }
      if (method === "lan/providers/list") result = { providers: [] };
      if (method === "config/read") result = { config: {} };
      if (method === "account/read") result = { account: null };
      if (method.startsWith("lan/projectModels/")) result = { projects: {} };
      if (method === "lan/projectless/read") result = { directories: {} };
      const auxiliary = [
        "model/list",
        "account/read",
        "config/read",
        "lan/providers/list",
      ].includes(method);
      setTimeout(
        () => {
          record.end = performance.now();
          this.onmessage({ data: JSON.stringify({ id, result }) });
        },
        auxiliary && state.slow
          ? state.metadataDelay
          : method.startsWith("thread/")
            ? 15
            : 0,
      );
    }
    close() {
      this.readyState = 3;
    }
  };
}
