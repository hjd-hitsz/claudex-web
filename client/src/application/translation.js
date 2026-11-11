import { requestTranslationSettings } from "../infrastructure/translation-settings.js";
export function createTranslationSettings({
  get,
  set,
  subscribe,
  request = requestTranslationSettings,
}) {
  let revision = 0;
  let active = false;
  let busy = false;
  let timer;
  let resume = () => {};
  async function refresh(enabled) {
    const current = ++revision;
    try {
      const status = await request(enabled);
      if (current === revision && get().auth?.authenticated)
        set({ translation: status });
    } catch (error) {
      if (current === revision && get().auth?.authenticated)
        set({ translation: { ...get().translation, error: error.message } });
    }
  }
  function start() {
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      const authenticated = Boolean(get().auth?.authenticated);
      if (authenticated && !active) {
        active = true;
        refresh();
      }
      if (!authenticated && active) {
        active = false;
        revision++;
        clearTimeout(timer);
        timer = null;
        set({ translation: { enabled: false, state: "disabled", error: "" } });
      }
      const waiting =
        !busy && ["preparing", "downloading"].includes(get().translation.state);
      if (active && waiting && !timer)
        timer = setTimeout(async () => {
          timer = null;
          await refresh();
          sync();
        }, 1000);
      if (!waiting && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    resume = sync;
    const unsubscribe = subscribe(sync);
    sync();
    return () => {
      resume = () => {};
      disposed = true;
      revision++;
      active = false;
      clearTimeout(timer);
      timer = null;
      unsubscribe();
    };
  }
  return {
    start,
    async setEnabled(enabled) {
      if (busy) return;
      busy = true;
      set({
        translation: {
          ...get().translation,
          enabled,
          state: enabled ? "preparing" : "disabled",
          error: "",
        },
      });
      try {
        await refresh(enabled);
      } finally {
        busy = false;
        resume();
      }
    },
  };
}
