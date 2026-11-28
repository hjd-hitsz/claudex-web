import { persist, saved } from "../infrastructure/storage.js";
import { compatibleEffort } from "../domain/model-preferences.js";
import { backendEnabled } from "../domain/backend-visibility.js";
import {
  isModelChoiceHidden,
  isModelHidden,
  modelProviderName,
} from "../domain/backends.js";
import { isBackendPreference } from "../../../shared/backend-preferences.mjs";
import { isSubagentSettings } from "../../../shared/subagent-settings.mjs";
import {
  modelServiceTiers,
  resolveServiceTier,
} from "../domain/service-tier.js";
function modelChoicesFor(choices, backendId, providerId) {
  return (choices || []).filter(
    (entry) => entry.backendId === backendId && entry.providerId === providerId,
  );
}

export function createBackends({
  get,
  set,
  rpc,
  models,
  transport,
  report,
  onSelectionChanged = () => {},
}) {
  let revision = 0;
  let agyCatalogue;

  function readAgyCatalogue(cwd) {
    const connection = transport?.connection;
    if (!agyCatalogue || agyCatalogue.connection !== connection)
      agyCatalogue = { connection };
    const cache = agyCatalogue;
    if (cache.data) return Promise.resolve(cache.data);
    return (cache.pending ||= rpc("model/list", {
      backendId: "agy",
      cwd,
      providerId: "",
    })
      .then(({ data }) => {
        if (
          !cache.data &&
          cache === agyCatalogue &&
          transport?.connection === connection
        )
          updateAgyCatalogue({ models: data });
        return cache.data ?? data;
      })
      .finally(() => (cache.pending = undefined)));
  }

  function updateAgyCatalogue({ models: data, model, effort }) {
    if (!backendEnabled(get().backends, "agy")) return;
    const connection = transport?.connection;
    if (!agyCatalogue || agyCatalogue.connection !== connection)
      agyCatalogue = { connection };
    agyCatalogue.data = data;
    const { backendId, cwd, current, projectless } = get();
    const choices = data.map((entry) => ({
      ...entry,
      backendId: "agy",
      providerId: "",
      providerName: "Antigravity",
    }));
    const patch = {
      modelChoices: [
        ...(get().modelChoices || []).filter(
          (entry) => entry.backendId !== "agy",
        ),
        ...choices,
      ],
    };
    if (backendId === "agy") {
      patch.models = choices;
      if (model !== undefined || effort !== undefined)
        models.configure({ model: model || "", effort: effort || "" });
      if (!current && !choices.some((choice) => choice.model === get().model)) {
        const backend = get().backends.find((entry) => entry.id === "agy");
        Object.assign(
          patch,
          models.projectModelSelection?.(
            cwd,
            projectless,
            models.defaults,
            choices.filter((entry) => !isModelHidden(backend, entry.model, "")),
          ),
        );
      }
    }
    set(patch);
  }

  async function activateBackend(id, choice) {
    if (!get().backends?.length) return;
    const epoch = ++revision;
    if (!backendEnabled(get().backends, id)) {
      models.disconnect();
      set({
        models: [],
        modelChoices: [],
        model: "",
        effort: "",
        serviceTier: null,
        providers: [],
        skills: [],
        nativeCommands: [],
        nativeAgents: [],
        account: null,
        usage: null,
        usageLoading: false,
        usageError: "",
      });
      return;
    }
    const connection = transport?.connection;
    const cwd = get().cwd;
    const current = () =>
      epoch === revision &&
      backendEnabled(get().backends, id) &&
      get().backendId === id &&
      get().cwd === cwd &&
      (!transport || (transport.connection === connection && get().connected));
    const previous = get().backendId || "codex";
    const threadId = previous === id ? get().current?.id : null;
    const threadSelection =
      (choice && {
        model: choice.model,
        providerId: choice.providerId,
        effort: get().effort,
        serviceTier: get().serviceTier,
      }) ||
      (previous === id && (threadId || get().model)
        ? {
            model: get().model,
            effort: get().effort,
            providerId: get().providerId,
            serviceTier: get().serviceTier,
          }
        : null);
    const initialProvider =
      threadSelection?.providerId ?? saved("cx-provider-" + id, "");
    const sameAccount = previous === id && initialProvider === get().providerId;
    const modelRevision = models.revision;
    const cachedModels =
      sameAccount && !choice
        ? get().models
        : modelChoicesFor(get().modelChoices, id, initialProvider);
    const available = (list) => {
      const backend = get().backends.find((entry) => entry.id === id);
      return id === "agy" || id === "claude"
        ? list.filter((entry) => !isModelChoiceHidden(backend, entry))
        : list;
    };
    const restoreDraft = (list) => {
      const choices = available(list);
      return (
        models.projectModelSelection?.(
          cwd,
          get().projectless,
          models.defaults,
          choices,
        ) || {
          model:
            choices.find((entry) => entry.isDefault)?.model ||
            choices[0]?.model ||
            "",
          effort: "",
        }
      );
    };
    models.disconnect();
    set({
      backendId: id,
      ...(previous !== id && {
        terminalOpen: false,
        contextOpen: false,
        agyDelegateTo: undefined,
        panel: null,
        panelFile: null,
      }),
      providers: sameAccount ? get().providers : [],
      providerId: initialProvider,
      models: cachedModels,
      model: "",
      effort: "",
      ...(!sameAccount && {
        account: null,
        usage: null,
        usageError: "",
        usageLoading: false,
      }),
      skills: sameAccount ? get().skills : [],
      nativeCommands: sameAccount ? get().nativeCommands : [],
      nativeAgents: sameAccount ? get().nativeAgents : [],
      serviceTier: null,
      ...threadSelection,
    });
    persist("cx-backend", id);
    if (!threadSelection && !get().current && cachedModels?.length)
      set(restoreDraft(cachedModels));

    const initialSelection = () =>
      !choice && !get().current && models.revision === modelRevision;
    const preferences = models.syncProjectModels?.().catch((error) => {
      if (current()) report(error);
    });
    const providerList = rpc("lan/providers/list", { backendId: "claude" })
      .then((result) => result.providers || [])
      .catch(() => null);
    const catalogues = new Map();
    function readCatalogue(backendId, providerId, provider) {
      const key = JSON.stringify([backendId, providerId]);
      if (catalogues.has(key)) return catalogues.get(key);
      const list =
        backendId === "agy"
          ? readAgyCatalogue(cwd)
          : rpc("model/list", { backendId, cwd, providerId }).then(
              (result) => result.data,
            );
      const request = list
        .catch((error) => {
          if (!provider) throw error;
          return provider.models.map((model) => ({
            id: model,
            model,
            supportedReasoningEfforts: [],
          }));
        })
        .then((list) => {
          const providerName =
            provider?.name || modelProviderName([], backendId, providerId);
          const choices = list.map((model) => ({
            ...model,
            displayName:
              provider?.modelAliases?.[model.model] ||
              model.displayName ||
              model.model,
            backendId,
            providerId,
            providerName,
            ...(provider?.hiddenModels?.includes(model.model) && {
              providerModelHidden: true,
            }),
          }));
          if (current())
            set({
              modelChoices: [
                ...(get().modelChoices || []).filter(
                  (entry) =>
                    entry.backendId !== backendId ||
                    entry.providerId !== providerId,
                ),
                ...choices,
              ],
            });
          return choices;
        });
      catalogues.set(key, request);
      return request;
    }

    async function restoreActiveBackend() {
      const configured = initialProvider ? await providerList : null;
      if (!current() || get().providerId !== initialProvider) return;
      const provider = configured?.find(
        (entry) => entry.id === initialProvider,
      );
      const providerId =
        configured && !provider && initialSelection() ? "" : initialProvider;
      if (providerId !== initialProvider)
        set({ providerId, model: "", effort: "", models: [] });
      const selected = () => current() && get().providerId === providerId;
      const params = { backendId: id, cwd, providerId };
      const account = rpc("account/read", { ...params, refreshToken: false })
        .then((result) => {
          if (selected()) set({ account: result.account });
        })
        .catch(() => {});
      const configuration = rpc("config/read", {
        ...params,
        includeLayers: false,
      })
        .then((result) => result.config || {})
        .catch(() => ({}));
      const catalogue = await readCatalogue(id, providerId, provider).catch(
        (error) => {
          if (selected()) report(error);
          return null;
        },
      );
      if (catalogue && selected()) {
        const applyDraft = () => {
          if (selected() && initialSelection()) set(restoreDraft(get().models));
        };
        const selectedModel = catalogue.find(
          (entry) => entry.model === get().model,
        );
        const tier = resolveServiceTier(get().serviceTier, selectedModel);
        set({
          models: catalogue,
          ...(selectedModel && {
            effort: compatibleEffort(get().effort, selectedModel),
            serviceTier: modelServiceTiers(selectedModel).some(
              (option) => option.id === tier,
            )
              ? tier
              : null,
          }),
        });
        applyDraft();
        const config = await configuration;
        if (selected()) {
          models.configure({
            model: config.model || "",
            effort: config.model_reasoning_effort || "",
          });
          if (initialSelection()) {
            if (!threadSelection)
              set({ serviceTier: config.service_tier ?? null });
            applyDraft();
          }
        }
        await preferences;
        applyDraft();
      }
      await account;
    }

    const active = restoreActiveBackend();
    const native = get()
      .backends.filter(
        (backend) =>
          backend.enabled &&
          (backend.id !== id || initialProvider) &&
          (backend.id !== "agy" || backend.ready),
      )
      .map((backend) => readCatalogue(backend.id, "").catch(() => {}));
    const providers = providerList.then(async (configured) => {
      if (!configured || !current()) return;
      const enabled = new Set(configured.map(({ id }) => id));
      set({
        modelChoices: (get().modelChoices || []).filter(
          (entry) =>
            entry.backendId !== "claude" ||
            !entry.providerId ||
            enabled.has(entry.providerId),
        ),
      });
      const records = await Promise.all(
        configured.map(async (provider) => ({
          ...provider,
          modelRecords: await readCatalogue("claude", provider.id, provider),
        })),
      );
      if (current() && id === "claude") set({ providers: records });
    });
    await Promise.all([active, preferences, providers, ...native]);
  }
  function selectProvider(id, choice) {
    id ??= "";
    const changed = id !== get().providerId;
    const provider = get().providers.find((p) => p.id === id);
    if (!provider && id && !choice) return;
    const models =
      provider?.modelRecords ||
      (provider
        ? provider.models.map((model) => ({
            id: model,
            model,
            providerId: id,
            providerModelHidden: provider.hiddenModels?.includes(model),
            displayName: provider.modelAliases?.[model] || model,
            supportedReasoningEfforts: [],
          }))
        : get().modelChoices.filter(
            (entry) => entry.backendId === "claude" && entry.providerId === id,
          ));
    set({
      providerId: id,
      models,
      skills: [],
      nativeCommands: [],
      nativeAgents: [],
      ...(changed && {
        account: null,
        usage: null,
        usageError: "",
        usageLoading: false,
      }),
      ...(choice
        ? { model: choice.model }
        : {
            model:
              models.find(
                (model) =>
                  !isModelChoiceHidden(
                    get().backends.find((backend) => backend.id === "claude"),
                    model,
                  ),
              )?.model || "",
            effort: "",
          }),
    });
    persist("cx-provider-" + get().backendId, id);
    if (changed) onSelectionChanged();
  }
  async function selectModelChoice(choice) {
    if (
      !choice ||
      get().busy ||
      get().loading ||
      choice.backendId !== get().backendId ||
      isModelChoiceHidden(
        get().backends.find((backend) => backend.id === choice.backendId),
        choice,
      )
    )
      return;
    if (
      get().active[get().current?.id] &&
      choice.providerId !== get().providerId
    )
      return;
    if (choice.backendId === "claude" && choice.providerId !== get().providerId)
      selectProvider(choice.providerId, choice);
    models.selectModel(choice);
  }
  async function refreshBackends() {
    const result = await rpc("lan/backends/list");
    set({ backends: result.backends });
    await activateBackend(
      get().backendId || result.backends.find((b) => b.enabled)?.id,
    );
  }
  async function saveBackend(value) {
    const result = await rpc("lan/backends/save", value);
    set({ backends: result.backends });
    if (
      isSubagentSettings(value) ||
      isBackendPreference(value) ||
      value.delegates
    )
      return;
    await refreshBackends();
  }
  async function saveProvider(value) {
    const result = await rpc("lan/providers/save", value);
    await activateBackend(get().backendId);
    return result;
  }
  async function refreshProvider(value) {
    const result = await rpc("lan/providers/refresh", value);
    if (!result.preview) await activateBackend(get().backendId);
    return result;
  }
  async function removeProvider(value) {
    const result = await rpc("lan/providers/remove", value);
    if (!get().current && get().providerId === value.id) {
      set({ providerId: "", model: "", effort: "" });
      persist("cx-provider-" + get().backendId, "");
    }
    await activateBackend(get().backendId);
    return result;
  }
  return {
    removeProvider,
    activateBackend,
    readAgyCatalogue,
    updateAgyCatalogue,
    selectModelChoice,
    selectProvider,
    refreshBackends,
    saveBackend,
    saveProvider,
    refreshProvider,
    report,
  };
}
