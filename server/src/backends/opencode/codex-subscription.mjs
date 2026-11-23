import { subscriptionVariants } from "./model-settings.mjs";
const baseURL = "https://chatgpt.com/backend-api/codex";
export function createCodexSubscription(source) {
  let current = null;
  const contexts = new Set();
  async function sync() {
    const next = await source.read().catch(() => null);
    const changed =
      current?.accountID !== next?.accountID ||
      JSON.stringify(current?.modelCatalogue || current?.models) !==
        JSON.stringify(next?.modelCatalogue || next?.models);
    current = next;
    if (changed)
      await Promise.all([...contexts].map((ctx) => ctx.provider.reload()));
    return current;
  }
  async function headers(url, sessionID) {
    const target = new URL(url);
    if (
      target.origin !== "https://chatgpt.com" ||
      !target.pathname.startsWith("/backend-api/codex/")
    )
      throw new Error("Codex 订阅请求地址无效。");
    const account = await source.read();
    if (!account) throw new Error("请先在 Codex 后端登录 ChatGPT。");
    return {
      authorization: `Bearer ${account.access}`,
      "chatgpt-account-id": account.accountID,
      originator: "opencode",
      "session-id": sessionID,
    };
  }
  const plugin = {
    id: "claudex.codex-subscription",
    async setup(ctx) {
      contexts.add(ctx);
      await ctx.provider.transform((editor) => {
        if (!editor.get("openai")) return;
        editor.update("openai", (provider) => {
          // Isolate this runtime from OpenCode's independently saved accounts.
          provider.integrationID = "claudex-codex";
          provider.activation = current ? "enabled" : "disabled";
          provider.settings = {
            ...provider.settings,
            baseURL,
            apiKey: "codex-managed",
            transport: "http",
            encoding: "zstd",
          };
        });
      });
      await ctx.model.transform((editor) => {
        for (const model of editor.list("openai"))
          editor.update("openai", model.id, (draft) => {
            draft.enabled = Boolean(
              current?.models.includes(draft.modelID || draft.id),
            );
            draft.cost = [];
            draft.settings = {
              ...draft.settings,
              baseURL,
              apiKey: "codex-managed",
            };
          });
        for (const model of current?.modelCatalogue || [])
          editor.update("openai", model.model, (draft) => {
            draft.modelID = model.model;
            draft.name = model.displayName;
            draft.enabled = true;
            draft.package = "@opencode/ai/providers/openai/responses";
            draft.cost = [];
            draft.capabilities.input = model.inputModalities || ["text"];
            draft.variants = subscriptionVariants(model);
            draft.settings = {
              ...draft.settings,
              baseURL,
              apiKey: "codex-managed",
            };
            draft.body = {
              ...draft.body,
              reasoning: { effort: model.defaultReasoningEffort },
            };
          });
      });
      await ctx.session.hook(
        "model.request",
        (evt) => {
          evt.baseURL = baseURL;
        },
        { providerID: "openai" },
      );
      await ctx.session.hook(
        "http.request",
        async (evt) => {
          const values = await headers(evt.request.url, evt.sessionID);
          for (const [key, value] of Object.entries(values))
            evt.request.headers.set(key, value);
        },
        { providerID: "openai" },
      );
      for (const name of ["context", "compaction"])
        await ctx.session.hook(
          name,
          (evt) => {
            delete evt.options.maxTokens;
          },
          { providerID: "openai" },
        );
      return () => {
        contexts.delete(ctx);
      };
    },
  };
  return {
    plugin,
    sync,
    read: () => source.read(),
    close: () => source.close(),
  };
}
