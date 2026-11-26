import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { acpConfiguration } from "../src/backends/agy/acp-models.mjs";
import { createAgyModelCatalogue } from "../src/backends/agy/model-catalogue.mjs";

test("Antigravity 目录按可用原生版本过滤，并保留各模型的独立思考档位", () => {
  const native = {
    models: {
      currentModelId: "gemini-3.8-flash-high",
      availableModels: [
        "gemini-4-hydrogen-high",
        "gemini-4-hydrogen-xhigh",
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-low",
        "claude-sonnet-4-6",
        "gpt-oss-120b-medium",
      ].map((modelId) => ({ modelId })),
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "gemini-3.8-flash",
        options: [
          {
            group: "Original",
            options: [
              ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
              ["gemini-3.8-flash", "Gemini 3.8 Flash"],
              ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
              ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
              ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
            ].map(([value, name]) => ({ value, name })),
          },
        ],
      },
      {
        id: "thought_level",
        category: "thought_level",
        currentValue: "high",
        options: ["low", "medium", "high"].map((value) => ({ value })),
      },
    ],
  };
  const result = acpConfiguration(native);
  assert.equal(result.model, "gemini-3.8-flash");
  assert.equal(result.effort, "high");
  assert.deepEqual(
    result.models.map(
      ({ model, supportedReasoningEfforts, defaultReasoningEffort }) => [
        model,
        supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort),
        defaultReasoningEffort,
      ],
    ),
    [
      ["gemini-4-hydrogen", ["high", "xhigh"], undefined],
      ["gemini-3.8-flash", ["low", "high"], "high"],
      ["claude-sonnet-4-6", [], undefined],
      ["gpt-oss-120b-medium", [], undefined],
    ],
  );
  assert.deepEqual(
    acpConfiguration({
      ...native,
      models: { availableModels: [] },
    }).models,
    [],
  );
});

test("Antigravity 目录合并首次读取，定时刷新并在失败时保留上次目录", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const published = [];
  const requests = [];
  const catalogue = createAgyModelCatalogue({
    read: () =>
      new Promise((resolve, reject) => requests.push({ resolve, reject })),
    publish: (snapshot) => published.push(snapshot),
  });
  t.after(() => catalogue.close());

  const first = catalogue.get();
  assert.equal(catalogue.get(), first);
  const previous = {
    model: "gemini-first",
    models: [{ model: "gemini-first" }],
  };
  requests[0].resolve(previous);
  assert.equal(await first, previous);
  t.mock.timers.tick(299999);
  assert.equal(requests.length, 1);

  t.mock.timers.tick(1);
  assert.equal(requests.length, 2);
  assert.equal(await catalogue.get(), previous);
  requests[1].reject(new Error("ACP 暂时不可用"));
  await setImmediate();
  assert.equal(await catalogue.get(), previous);
  assert.deepEqual(published, [previous]);

  t.mock.timers.tick(300000);
  const updated = { model: "gemini-next", models: [{ model: "gemini-next" }] };
  requests[2].resolve(updated);
  await setImmediate();
  assert.equal(await catalogue.get(), updated);
  assert.deepEqual(published, [previous, updated]);
  catalogue.close();
  t.mock.timers.tick(300000);
  assert.equal(requests.length, 3);
});
