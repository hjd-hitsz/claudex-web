import assert from "node:assert/strict";
import test from "node:test";
import {
  createErrorFeedback,
  rpcFeedbackKey,
} from "../src/application/error-feedback.js";
import { RpcConnectionError } from "../src/infrastructure/rpc-client.js";

test("操作反馈按请求目标与对话归属结算", async () => {
  const state = { error: "" };
  let opening = 1;
  const feedback = createErrorFeedback({
    get: () => state,
    set: (patch) => Object.assign(state, patch),
    opening: () => opening,
  });
  const write = (path, dataBase64) =>
    rpcFeedbackKey("fs/writeFile", { path, dataBase64 });
  const fail = (message) => async () => {
    throw new Error(message);
  };
  const read = rpcFeedbackKey("fs/readFile", { path: "/first.md" });
  await feedback
    .track(write("/first.md"), fail("保存失败"))
    .catch(feedback.report);
  await feedback.track(write("/second.md"), async () => {});
  await feedback.track(read, async () => {});
  assert.equal(state.error, "保存失败");
  await feedback.track(write("/first.md", "更新后的文件内容"), async () => {});
  assert.equal(state.error, "");

  let rejectPrevious;
  const previous = feedback
    .track(read, () => new Promise((_, reject) => (rejectPrevious = reject)))
    .catch(feedback.report);
  await feedback.track(read, async () => {});
  rejectPrevious(new Error("前一次读取迟到的错误"));
  await previous;
  assert.equal(state.error, "");

  let finishPrevious;
  const slow = feedback.track(
    read,
    () => new Promise((resolve) => (finishPrevious = resolve)),
  );
  await feedback.track(read, fail("近期读取失败")).catch(feedback.report);
  finishPrevious();
  await slow;
  assert.equal(state.error, "近期读取失败");

  let leave;
  const opened = feedback
    .track(read, () => new Promise((_, reject) => (leave = reject)))
    .catch(feedback.report);
  opening++;
  feedback.reset();
  leave(new Error("旧对话读取失败"));
  await opened;
  assert.equal(state.error, "");
  await feedback
    .track(read, async () => {
      throw new RpcConnectionError("请求发送时连接尚未就绪。");
    })
    .catch(feedback.report);
  assert.equal(state.error, "");

  const send = feedback.start("send-message");
  feedback.report(new Error("消息需缩减附件"), send);
  await feedback.track(read, async () => {});
  assert.equal(state.error, "消息需缩减附件");
  feedback.resolve(feedback.start("send-message"));
  assert.equal(state.error, "");
});
