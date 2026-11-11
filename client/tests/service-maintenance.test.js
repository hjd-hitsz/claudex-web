import test from "node:test";
import assert from "node:assert/strict";
import { createServiceMaintenance } from "../src/application/service-maintenance.js";

const taskStatus = (state, startedAt = "2026-11-11T10:00:00.000Z") => ({
  current: "4.0.1",
  task: {
    state,
    startedAt,
    action: "restart",
    error: state === "failed" ? "重启失败" : "",
  },
});

test("首次加载和检查版本跳过持久任务的旧完成、失败结果", async () => {
  for (const terminal of ["completed", "failed"]) {
    const controller = createServiceMaintenance({
      request: async () => taskStatus(terminal),
    });
    await controller.request();
    await controller.request("check");
    assert.equal(controller.get().notice, null);
    assert.equal(controller.get().refreshNeeded, false);
    assert.equal(controller.get().error, "");
  }
});

test("当前访问发起的重启只提示一次，关闭后轮询、重连均不恢复提示", async () => {
  let state = "restarting";
  const controller = createServiceMaintenance({
    request: async () => taskStatus(state),
  });
  await controller.request("restart");
  state = "completed";
  await controller.request();
  assert.equal(controller.get().notice.message, "服务已重启，请刷新网页。");
  assert.equal(controller.get().refreshNeeded, true);
  controller.dismissFeedback();
  await controller.request();
  await controller.request();
  assert.equal(controller.get().notice, null);
  assert.equal(controller.get().refreshNeeded, false);
});

test("刷新后的新控制器保留任务事实并跳过已结束操作的提示", async () => {
  let state = "restarting";
  const request = async () => taskStatus(state);
  const first = createServiceMaintenance({ request });
  await first.request("restart");
  state = "completed";
  await first.request();
  const refreshed = createServiceMaintenance({ request });
  await refreshed.request();
  assert.equal(refreshed.get().status.task.state, "completed");
  assert.equal(refreshed.get().notice, null);
  assert.equal(refreshed.get().refreshNeeded, false);
});

test("关闭设置后才收到重启请求确认，后续完成反馈保持失效", async () => {
  let resolve;
  let response = new Promise((done) => {
    resolve = done;
  });
  const controller = createServiceMaintenance({ request: () => response });
  const pending = controller.request("restart");
  controller.dismissFeedback();
  resolve(taskStatus("restarting"));
  await pending;
  response = Promise.resolve(taskStatus("completed"));
  await controller.request();
  assert.equal(controller.get().notice, null);
  assert.equal(controller.get().refreshNeeded, false);
});

test("关闭设置后才收到失败响应，提示保持清除，重试属于新访问", async () => {
  let reject;
  let response = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const controller = createServiceMaintenance({ request: () => response });
  const pending = controller.request("restart");
  controller.dismissFeedback();
  reject(new Error("迟到的请求失败"));
  await pending;
  assert.equal(controller.get().error, "");
  response = Promise.resolve(
    taskStatus("restarting", "2026-11-11T11:00:00.000Z"),
  );
  await controller.request("restart");
  response = Promise.resolve(
    taskStatus("completed", "2026-11-11T11:00:00.000Z"),
  );
  await controller.request();
  assert.equal(controller.get().refreshNeeded, true);
  controller.dismissFeedback();
});

test("关闭设置前已确认的运行任务，结束后保留事实并清除该次提示", async () => {
  let state = "restarting";
  const controller = createServiceMaintenance({
    request: async () => taskStatus(state),
  });
  await controller.request("restart");
  controller.dismissFeedback();
  state = "completed";
  await controller.request();
  assert.equal(controller.get().status.task.state, "completed");
  assert.equal(controller.get().notice, null);
});

test("失败结果提示清除后，重复任务快照保持安静", async () => {
  let state = "restarting";
  const controller = createServiceMaintenance({
    request: async () => taskStatus(state),
  });
  await controller.request("restart");
  state = "failed";
  await controller.request();
  assert.equal(controller.get().notice.message, "重启失败");
  controller.dismissFeedback();
  await controller.request();
  assert.equal(controller.get().notice, null);
});

test("忙碌操作退出等待状态，错误五秒后关闭", async () => {
  const controller = createServiceMaintenance({
    request: async () => {
      throw new Error("任务仍在运行，请结束后重试。");
    },
  });
  await controller.request("restart");
  assert.equal(controller.get().pending, false);
  assert.match(controller.get().error, /请结束后重试/);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  assert.equal(controller.get().error, "");
});

test("退出后迟到的状态读取错误同样失效，新读取仍可报告真实故障", async () => {
  let reject;
  let response = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const controller = createServiceMaintenance({ request: () => response });
  const pending = controller.request();
  controller.dismissFeedback();
  reject(new Error("旧读取失败"));
  await pending;
  assert.equal(controller.get().loadError, "");
  response = Promise.reject(new Error("当前连接失败"));
  await controller.request();
  assert.equal(controller.get().loadError, "当前连接失败");
  controller.dismissFeedback();
  assert.equal(controller.get().loadError, "");
});
