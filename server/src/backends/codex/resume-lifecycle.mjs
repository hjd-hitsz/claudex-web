// Codex 0.169 的取消订阅响应先于实际关闭，恢复请求可在这段间隔被拒绝。
// 只在原生明确报告目标线程正在关闭时等待其关闭事件，沿用原请求期限。
export function createResumeLifecycle({ pending, send }) {
  function resume(id, request) {
    request.waitingForClose = false;
    request.closedSinceResume = false;
    send({ id, method: "thread/resume", params: request.resumeParams });
  }

  return {
    defer(id, request, error) {
      const threadId = request.resumeParams?.threadId;
      if (
        request.method !== "thread/resume" ||
        !threadId ||
        request.timedOut ||
        request.resumeRetried ||
        error?.code !== -32600 ||
        ![
          `thread ${threadId} is closing; retry thread/resume after the thread is closed`,
          `thread ${threadId} is closing; retry after the thread is closed`,
        ].includes(error.message)
      )
        return false;
      request.resumeRetried = true;
      request.waitingForClose = true;
      if (request.closedSinceResume) resume(id, request);
      return true;
    },
    closed(threadId) {
      for (const [id, request] of pending) {
        if (request.resumeParams?.threadId !== threadId) continue;
        request.closedSinceResume = true;
        if (request.waitingForClose) resume(id, request);
      }
    },
  };
}
