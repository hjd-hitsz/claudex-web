import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClaudeRuntime } from "../../server/src/backends/claude/runtime.mjs";
import { createStorage } from "../../server/src/backends/storage.mjs";
import { createCompactions } from "../../server/src/compaction.mjs";
import { messagesServer } from "../helpers/claude-messages-server.mjs";

async function verify(mode) {
  const root = await mkdtemp(join(tmpdir(), "claudex-subagent-models-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const id = randomUUID();
  let round = 0,
    issued = false;
  let childModel = mode === "same-provider" ? "fixture-child" : "fixture-main";
  const childRequests = [];
  const child = await messagesServer((body) => {
    childRequests.push(body);
    return [{ type: "text", text: `CHILD_ANSWER_${round}` }];
  });
  const main = await messagesServer((body) => {
    if (body.model.startsWith("fixture-child")) {
      childRequests.push(body);
      return [{ type: "text", text: `CHILD_ANSWER_${round}` }];
    }
    if (!issued && body.tools?.some((tool) => tool.name === "Agent")) {
      issued = true;
      return [
        {
          type: "tool_use",
          id: `child-${round}`,
          name: "Agent",
          input: {
            description: "Verify configured child model",
            subagent_type: round === 1 ? "general-purpose" : "Explore",
            prompt: `CHILD_TASK_${round}: return a proof marker.`,
          },
        },
      ];
    }
    return [{ type: "text", text: `PARENT_ANSWER_${round}` }];
  });
  const primary = {
    id: "primary",
    protocol: "messages",
    baseUrl: main.url,
    apiKey: "primary-key",
    models: ["fixture-main", "fixture-child", "fixture-child-next"],
    modelCapabilities: Object.fromEntries(
      ["fixture-main", "fixture-child", "fixture-child-next"].map((model) => [
        model,
        {
          supportedEffortLevels: ["low", "high"],
          supportsAdaptiveThinking: false,
        },
      ]),
    ),
  };
  const secondary = {
    id: "secondary",
    protocol: "messages",
    baseUrl: child.url,
    apiKey: "child-key",
    models: [childModel, "fixture-next"],
    modelCapabilities: {
      [childModel]: {
        supportedEffortLevels: ["low", "high"],
        supportsAdaptiveThinking: false,
      },
      "fixture-next": {
        supportedEffortLevels: ["low", "high"],
        supportsAdaptiveThinking: false,
      },
    },
  };
  const backend = {
    id: "claude",
    executable: process.env.CLAUDE_EXECUTABLE || "claude",
    dataDir: join(root, "native"),
    stateDir: join(root, "state"),
    args: [],
    subagentModel: childModel,
    subagentEffort: "high",
    ...(mode !== "same-provider" && {
      subagentProviderId: mode === "native-child" ? "@native" : "secondary",
    }),
  };
  const storage = createStorage(join(root, "index.json"), {
    sessions: {
      [id]: {
        id,
        cwd,
        providerId: mode === "native-main" ? "" : "primary",
        model: "fixture-main",
        turns: {},
        queue: [],
      },
    },
  });
  const events = [];
  const broadcast = (event) => events.push(event);
  const previousBase = process.env.ANTHROPIC_BASE_URL;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  if (mode === "native-main") {
    process.env.ANTHROPIC_BASE_URL = main.url;
    process.env.ANTHROPIC_API_KEY = "native-main-key";
  }
  if (mode === "native-child") {
    process.env.ANTHROPIC_BASE_URL = child.url;
    process.env.ANTHROPIC_API_KEY = "native-child-key";
  }
  let available = true;
  let settings = {
    subagentModel: backend.subagentModel,
    subagentProviderId: backend.subagentProviderId || "",
    subagentEffort: "high",
  };
  const runtime = createClaudeRuntime({
    backend,
    readSubagentSettings: async () => settings,
    storage,
    broadcast,
    compactions: createCompactions(broadcast),
    questions: new Map(),
    providers: {
      get: async (_backendId, providerId) => {
        if (providerId === "secondary") {
          if (!available) throw new Error("供应商已停用");
          return secondary;
        }
        return providerId ? primary : null;
      },
    },
  });
  async function send() {
    issued = false;
    round++;
    const { turn } = await runtime.enqueue(id, {
      effort: "low",
      input: [
        {
          type: "text",
          text: `PARENT_TASK_${round}: delegate a proof task and wait for its result.`,
        },
      ],
    });
    for (let i = 0; i < 2000; i++) {
      const done = events.find(
        (event) =>
          event.method === "turn/completed" && event.params.turn.id === turn.id,
      );
      if (done) return done.params.turn;
      await delay(25);
    }
    throw new Error(
      `Native request timed out: ${JSON.stringify(events.slice(-5))}`,
    );
  }
  try {
    await runtime.check();
    let nativeProcess;
    for (let i = 0; i < 2; i++) {
      if (i === 1)
        childModel =
          mode === "same-provider" ? "fixture-child-next" : "fixture-next";
      settings = { ...settings, subagentEffort: i === 0 ? "high" : "low" };
      settings.subagentModel = childModel;
      const before = childRequests.length;
      const turn = await send();
      assert.equal(turn.status, "completed", JSON.stringify(turn));
      if (i === 0) nativeProcess = runtime.queries.get(id);
      else
        assert.equal(
          runtime.queries.get(id),
          nativeProcess,
          "子代理配置更新保持同一原生主会话",
        );
      assert.ok(issued, "the actual CLI invokes Agent");
      assert.ok(
        childRequests.length > before,
        `child reached its configured service: ${mode}, ${JSON.stringify(main.requests.map((body) => ({ model: body.model, last: body.messages?.at(-1) })))}`,
      );
      assert.ok(
        childRequests.slice(before).every((body) => body.model === childModel),
      );
      assert.ok(
        childRequests
          .slice(before)
          .every(
            (body) => body.output_config?.effort === settings.subagentEffort,
          ),
        JSON.stringify(
          childRequests.slice(before).map((body) => ({
            model: body.model,
            effort: body.output_config?.effort,
          })),
        ),
      );
      assert.ok(
        JSON.stringify(childRequests.slice(before)).includes(
          `CHILD_TASK_${round}`,
        ),
      );
      assert.match(JSON.stringify(turn), new RegExp(`PARENT_ANSWER_${round}`));
      const parentRequests = main.requests.filter(
        (body) =>
          body.model === "fixture-main" &&
          body.tools?.some((tool) => tool.name === "Agent"),
      );
      assert.ok(
        parentRequests.length &&
          parentRequests.every((body) => body.output_config?.effort === "low"),
        JSON.stringify(parentRequests.map((body) => body.output_config)),
      );
    }
    settings = {
      subagentModel: "",
      subagentProviderId: "",
      subagentEffort: "",
    };
    const beforeClear = childRequests.length;
    assert.equal((await send()).status, "completed");
    assert.equal(
      runtime.queries.get(id),
      nativeProcess,
      "清空默认配置保持原生会话",
    );
    assert.equal(
      childRequests.length,
      beforeClear,
      "清空后新子代理回到主供应商默认模型",
    );
    if (mode === "cross-provider" || mode === "native-main") {
      settings = {
        subagentModel: childModel,
        subagentProviderId: "secondary",
        subagentEffort: "low",
      };
      assert.ok(main.requests.every((body) => body.model === "fixture-main"));
      assert.equal(child.requests.length, childRequests.length);
      available = false;
      const turn = await send();
      assert.equal(turn.status, "failed");
      assert.match(JSON.stringify(turn), /供应商已停用/);
      available = true;
      assert.equal((await send()).status, "completed");
    }
    console.log(
      JSON.stringify({
        mode,
        rounds: round,
        mainRequests: main.requests.length,
        childRequests: childRequests.length,
        childModel,
        parentEffort: "low",
        childEfforts: ["high", "low"],
        nativeCLI: true,
      }),
    );
  } finally {
    const processes = [...runtime.queries.values()];
    runtime.close();
    await Promise.all(processes.map((process) => process.done));
    await main.close();
    await child.close();
    if (previousBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
}
for (const mode of [
  "same-provider",
  "cross-provider",
  "native-main",
  "native-child",
])
  await verify(mode);
