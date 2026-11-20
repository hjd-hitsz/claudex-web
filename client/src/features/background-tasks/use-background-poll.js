import { useEffect, useRef } from "react";

export function useBackgroundPoll(enabled, period, refresh, scope) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    let finished = false;
    let timer;
    const current = () => !disposed;
    async function poll() {
      clearTimeout(timer);
      if (disposed || busy || finished || document.hidden) return;
      busy = true;
      try {
        finished = (await latest.current(current)) === true;
        if (finished) return;
        if (!disposed && !document.hidden) timer = setTimeout(poll, period);
      } finally {
        busy = false;
      }
    }
    function visible() {
      if (document.hidden) clearTimeout(timer);
      else poll();
    }
    document.addEventListener("visibilitychange", visible);
    poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, period, scope]);
}
