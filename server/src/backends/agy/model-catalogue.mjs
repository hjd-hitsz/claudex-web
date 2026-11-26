const refreshInterval = 5 * 60 * 1000;

export function createAgyModelCatalogue({ read, publish }) {
  let cached;
  let pending;
  let timer;
  let closed = false;

  function refresh() {
    if (pending) return pending;
    if (closed) return Promise.reject(new Error("agy 模型目录已关闭"));
    clearTimeout(timer);
    pending = read()
      .then((result) => {
        if (!closed) {
          const changed = JSON.stringify(cached) !== JSON.stringify(result);
          cached = result;
          if (changed) publish(result);
        }
        return result;
      })
      .finally(() => {
        pending = undefined;
        if (closed) return;
        timer = setTimeout(() => refresh().catch(() => {}), refreshInterval);
        timer.unref?.();
      });
    return pending;
  }

  return {
    get: () => (cached ? Promise.resolve(cached) : refresh()),
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
