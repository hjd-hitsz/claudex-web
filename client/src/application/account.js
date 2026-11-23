import { mergeUsageUpdate } from "../domain/account-usage.js";
export function createAccount({ get, set, rpc, transport }) {
  let accountRevision = 0,
    usageRevision = 0,
    usageRequest = null;
  function refreshUsage() {
    if (
      !get().connected ||
      (get().account &&
        get().account.type !== "chatgpt" &&
        get().account.usageSupported !== true)
    )
      return Promise.resolve();
    const connection = transport.connection;
    const { backendId, providerId, cwd } = get();
    const model = backendId === "opencode" ? get().model : undefined;
    if (
      usageRequest?.connection === connection &&
      usageRequest.backendId === backendId &&
      usageRequest.providerId === providerId &&
      usageRequest.cwd === cwd &&
      usageRequest.model === model
    )
      return usageRequest.promise;
    const revision = usageRevision;
    const request = { connection, backendId, providerId, cwd, model };
    usageRequest = request;
    const current = () =>
      transport.connection === connection &&
      get().connected &&
      revision === usageRevision &&
      get().backendId === backendId &&
      get().providerId === providerId &&
      get().cwd === cwd &&
      (backendId !== "opencode" || get().model === model);
    set({ usageLoading: true });
    request.promise = rpc(
      "account/rateLimits/read",
      { backendId, providerId, cwd, model },
      20000,
    )
      .then((usage) => {
        if (current()) set({ usage, usageError: "" });
      })
      .catch((error) => {
        if (current()) set({ usageError: error.message });
      })
      .finally(() => {
        if (usageRequest === request) {
          usageRequest = null;
          set({ usageLoading: false });
        }
      });
    return request.promise;
  }
  function handle({ method, params: p = {} }) {
    if (method === "account/rateLimits/updated" && p.rateLimits) {
      usageRevision++;
      set({
        usage: mergeUsageUpdate(get().usage, p.rateLimits),
        usageError: "",
      });
      return;
    }
    if (method === "account/updated") {
      const revision = ++accountRevision;
      usageRevision++;
      usageRequest = null;
      const connection = transport.connection;
      const { backendId, providerId, cwd, model } = get();
      set({ account: null, usage: null, usageLoading: false, usageError: "" });
      rpc("account/read", {
        refreshToken: false,
        backendId,
        providerId,
        cwd,
        model,
      })
        .then((result) => {
          if (
            transport.connection !== connection ||
            !get().connected ||
            revision !== accountRevision ||
            get().backendId !== backendId ||
            get().providerId !== providerId ||
            get().cwd !== cwd ||
            (backendId === "opencode" && get().model !== model)
          )
            return;
          set({ account: result.account });
          return refreshUsage();
        })
        .catch(() => {});
      return;
    }
  }
  function reset() {
    usageRevision++;
    usageRequest = null;
  }
  return {
    refreshUsage,
    handle,
    reset,
    get revision() {
      return accountRevision;
    },
  };
}
