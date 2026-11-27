// ACP 缺口：agy 1.5.18 的 session/steer 和 turn/steer 返回 -32601 Method not found，
// 网页需要在生成中向当前轮次追加输入。
// 探测证据：同一 ACP 会话接受第二次 session/prompt。旧请求可能提前返回 end_turn，
// 最新请求在文本流结束后返回，Worker 以其结果结算网页轮次。
// 切换条件：ACP 提供运行中轮次的显式 steer 方法，追加后延续当前消息流和轮次。
// 登记见 [缺口登记](../../../../../docs/future_plan.md#缺口登记)。
export function startAgyPromptRun({ client, nativeId }, blocks, onSteerError) {
  const done = Promise.withResolvers();
  const pending = new Set();
  let latest;
  let cancelDeadline;

  function settle(request, result, error) {
    request.result = result;
    request.error = error;
    pending.delete(request);
    if (request.steer && error && !cancelDeadline) onSteerError?.(error);
    if (pending.size) return;
    clearTimeout(cancelDeadline);
    if (latest.error) done.reject(latest.error);
    else done.resolve(latest.result);
  }

  function send(prompt, steer = false) {
    const request = { steer };
    pending.add(request);
    latest = request;
    client.call("session/prompt", { sessionId: nativeId, prompt }, 0).then(
      (result) => settle(request, result),
      (error) => settle(request, undefined, error),
    );
  }

  send(blocks);
  return {
    done: done.promise,
    get running() {
      return pending.size > 0 && !cancelDeadline && !client.closed;
    },
    steer(prompt) {
      send(prompt, true);
    },
    cancel() {
      if (!this.running) return;
      cancelDeadline = setTimeout(() => client.close(), 10000);
      cancelDeadline.unref();
      try {
        client.notify("session/cancel", { sessionId: nativeId });
      } catch {
        client.close();
      }
    },
  };
}
