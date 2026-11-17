import assert from "node:assert/strict";
import test from "node:test";
import { createBackends } from "../src/application/backends.js";

for (const id of ["codex", "claude"]) {
  test(`${id} 子代理默认配置等待真实保存结果，保存后保留当前状态并结束请求`, async () => {
    const previous = [{ id, type: id, enabled: true, subagentModel: "old" }];
    const saved = [
      { ...previous[0], subagentModel: "child", subagentEffort: "high" },
    ];
    let state = {
      backends: previous,
      backendId: id,
      model: "parent",
      effort: "low",
      draft: "保留草稿",
      attachments: [{ id: "attachment" }],
      current: { id: "thread" },
      modelChoices: [{ model: "parent" }],
      account: { name: "account" },
    };
    const initial = { ...state };
    const calls = [];
    let resolveSave;
    const controller = createBackends({
      get: () => state,
      set: (patch) => {
        state = { ...state, ...patch };
      },
      models: {
        disconnect() {
          assert.fail("子代理配置应保持当前模型订阅");
        },
      },
      rpc(method, params) {
        calls.push({ method, params });
        assert.equal(method, "lan/backends/save", "保存后应结束目录和账户查询");
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      },
    });
    const input = {
      id,
      type: id,
      subagentModel: "child",
      subagentEffort: "high",
      ...(id === "claude" && { subagentProviderId: "vendor" }),
    };
    let completed = false;
    const saving = controller.saveBackend(input).then(() => {
      completed = true;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(state.backends, previous);
    resolveSave({ backends: saved });
    await saving;
    assert.equal(completed, true);
    assert.deepEqual(calls, [{ method: "lan/backends/save", params: input }]);
    assert.equal(state.backends, saved);
    assert.deepEqual({ ...state, backends: previous }, initial);
  });
}

test("子代理保存失败保留已保存配置，后续重试使用新输入", async () => {
  let state = { backends: [{ id: "codex", subagentModel: "old" }] };
  const original = state.backends;
  let fail = true;
  const controller = createBackends({
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    rpc: async (method, value) => {
      assert.equal(method, "lan/backends/save");
      if (fail) throw new Error("配置写入失败");
      return { backends: [value] };
    },
  });
  const input = { id: "codex", type: "codex", subagentModel: "child" };
  await assert.rejects(controller.saveBackend(input), /配置写入失败/);
  assert.equal(state.backends, original);
  fail = false;
  await controller.saveBackend({ ...input, subagentModel: "retry" });
  assert.equal(state.backends[0].subagentModel, "retry");
});
