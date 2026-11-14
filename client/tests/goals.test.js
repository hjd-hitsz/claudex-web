import test from "node:test";
import assert from "node:assert/strict";
import { createGoals } from "../src/application/goals.js";
function fixture(rpc) {
  let state = {
    connected: true,
    current: { id: "a" },
    goals: {},
    goalErrors: {},
    goalBusy: {},
    compactions: {},
    draft: "完成测试",
    attachments: [],
  };
  let notify;
  const controller = createGoals({
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    rpc,
    navigation: { ensureThread: async () => state.current },
    onEvent: (listener) => {
      notify = listener;
    },
  });
  return {
    controller,
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    notify: (event) => notify(event),
  };
}
test("实时目标通知优先于迟到读取，其他对话按 ID 保存", async () => {
  let finish;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const read = f.controller.refreshGoal();
  f.notify({
    method: "thread/goal/updated",
    params: { threadId: "a", goal: { status: "complete" } },
  });
  f.set({ current: { id: "b" } });
  finish({ goal: { status: "active" } });
  await read;
  assert.equal(f.get().goals.a.status, "complete");
  assert.equal(f.get().goals.b, undefined);
});
test("保存串行、重复点击只提交一次，通知优先于保存响应", async () => {
  let finish,
    calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const save = f.controller.updateGoal("a", { status: "active" });
  assert.equal(await f.controller.updateGoal("a", { status: "paused" }), false);
  f.notify({
    method: "thread/goal/updated",
    params: { threadId: "a", goal: { status: "paused" } },
  });
  finish({ goal: { status: "active" } });
  await save;
  assert.equal(calls, 1);
  assert.equal(f.get().goals.a.status, "paused");
  assert.equal(f.get().goalBusy.a, false);
});
test("失败保留目标输入和附件，允许重试", async () => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new Error("保存失败");
    return { goal: { objective: "完成测试" } };
  });
  f.set({ goalMode: true });
  await assert.rejects(f.controller.submitGoal(), /保存失败/);
  assert.equal(f.get().draft, "完成测试");
  assert.equal(f.get().goalMode, true);
  fail = false;
  globalThis.localStorage = { removeItem() {} };
  assert.equal(await f.controller.submitGoal(), true);
  assert.equal(f.get().draft, "");
  assert.equal(f.get().goalMode, false);
});
test("已有目标在替换前展示确认，取消保留输入", async () => {
  const f = fixture(() => {
    throw new Error("确认前禁止写入");
  });
  f.set({ goals: { a: { objective: "旧目标" } } });
  assert.equal(await f.controller.submitGoal(), false);
  assert.equal(f.get().modal.view, "goal-replace");
  assert.equal(f.get().draft, "完成测试");
});
test("读取失败保留已取得目标并显示实际错误", async () => {
  const f = fixture(async () => {
    throw new Error("连接失败");
  });
  f.set({ goals: { a: { objective: "旧目标" } } });
  await f.controller.refreshGoal();
  assert.equal(f.get().goals.a.objective, "旧目标");
  assert.equal(f.get().goalErrors.a, "连接失败");
});
