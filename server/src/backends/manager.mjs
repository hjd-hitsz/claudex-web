import { createBackendRequests } from "./manager-requests.mjs";
import { resolveNativeSecretaryRole } from "./delegation/settings.mjs";
import { createDelegationModes } from "./delegation/source-modes.mjs";
import { delegationModeRequests } from "./delegation/mode-requests.mjs";
import { createNativeDelegation } from "./delegation/native.mjs";
import { delegationRequest } from "./delegation/routing.mjs";
import { listBackendThreads } from "../conversation-manager/catalog.mjs";
import { createBackgroundService } from "./codex/background-service.mjs";
import { bindConversationTools } from "../conversation-manager/backend-binding.mjs";
import { createThreadFolders } from "../thread-folders.mjs";
import { createTokenUsageStore } from "../token-usage.mjs";
import { createTokenUsageReconciliation } from "../token-usage-reconciliation.mjs";
import { createCliInstallation } from "./cli-installation.mjs";
import { join } from "node:path";
import { readProjectlessDirectories } from "../thread-projects.mjs";
import { createWorkspace } from "../workspace/service.mjs";
import { isBackendPreference } from "../../../shared/backend-preferences.mjs";
import { hasBackendWork } from "../../../shared/backend-activity.mjs";
import {
  resourceTarget,
  resourceId,
} from "../../../shared/backend-identity.mjs";
import {
  createBackendConfiguration,
  validateBackend,
} from "./configuration.mjs";
import { createProviders } from "./providers.mjs";
import { isSubagentSettings } from "../../../shared/subagent-settings.mjs";
import { validateSubagentSettings } from "./subagent-settings.mjs";
import { createCodexAdapter } from "./codex/adapter.mjs";
import { createClaudeWorkerAdapter } from "./claude/worker-client.mjs";
import {
  mapNotification,
  mapResult,
  mapState,
  nativeParams,
} from "./identity-mapping.mjs";
import { createAgyWorkerAdapter } from "./agy/worker-client.mjs";
import { agyStateDirectory, isAgyPreference } from "./agy/configuration.mjs";
import { readAgyRole, saveAgyRole } from "./agy/role-settings.mjs";
import { createDelegatedThreadIndex } from "./delegation/delegated-threads.mjs";
const adapterFactories = {
  agy: createAgyWorkerAdapter,
  codex: createCodexAdapter,
  claude: createClaudeWorkerAdapter,
};
export function createBackendManager({
  config,
  version,
  send,
  broadcast,
  conversations,
  factories = {},
}) {
  const folders = createThreadFolders(config.configDir);
  const tokenUsage = createTokenUsageStore(config.configDir);
  const workspace = createWorkspace({ broadcast, configDir: config.configDir });
  const configuration = createBackendConfiguration(config);
  const hideDelegatedThreads = createDelegatedThreadIndex(config.configDir);
  const background = createBackgroundService(config);
  const providers = createProviders(configuration);
  const instances = new Map();
  const installationJobs = new Map();
  const installationErrors = new Map();
  const cli =
    factories.installation ||
    createCliInstallation({
      changed: () => {
        if (initialized) emitState();
      },
    });
  let initialized = false,
    closed = false;
  let changing = Promise.resolve();
  const delegationModes = createDelegationModes(config.configDir);
  const modeRequests = delegationModeRequests(
    delegationModes,
    Boolean(conversations),
  );
  const delegation = createNativeDelegation({
    config,
    version,
    emit: broadcast,
    changed: emitState,
    backendEntry: (id) => instances.get(id),
    modes: delegationModes,
  });
  const { proxy, call } = createBackendRequests({
    send,
    tokenUsage,
    projectResult,
  });
  const usageReconciliation = createTokenUsageReconciliation({
    store: tokenUsage,
    call,
    current: (entry) => !closed && instances.get(entry.backend.id) === entry,
  });
  const publicBackends = () =>
    [...instances.values()].map(({ backend, adapter, error }) => ({
      ...backend,
      ...(backend.type === "codex" && {
        backgroundTerminalAvailable: background.available,
      }),
      installation: {
        ...cli.state(backend.id),
        installing: installationJobs.has(backend.id),
        installError:
          installationErrors.get(backend.id) ||
          cli.state(backend.id).installError,
      },
      ready: Boolean(adapter?.ready),
      capabilities: adapter?.capabilities || {},
      error: error || adapter?.state().params.error || null,
    }));
  function state() {
    const states = [...instances.values()]
      .filter((i) => i.adapter)
      .map((i) => mapState(i.adapter.state().params, i.backend.id));
    const merge = (name) => Object.assign({}, ...states.map((s) => s[name]));
    return {
      method: "lan/state",
      params: {
        ready: [...instances.values()].some((i) => i.adapter?.ready),
        bridgeReady: initialized,
        protocolVersion: 2,
        backends: publicBackends(),
        defaultBackendId:
          [...instances.values()].find((i) => i.backend.enabled)?.backend.id ||
          "codex",
        version,
        defaultCwd: config.defaultCwd,
        projectlessRoot: config.projectlessRoot,
        projectlessRoots: [
          config.projectlessRoot,
          ...(config.legacyConfigDir
            ? [join(config.legacyConfigDir, "workspaces")]
            : []),
          join(
            instances.get("codex")?.backend.dataDir || config.codexHome,
            "codex-web",
            "workspaces",
          ),
        ],
        projectModels: true,
        nativeDelegation: Boolean(conversations),
        questions: [
          ...states.flatMap((s) => s.questions),
          ...delegation.snapshot().questions,
        ],
        delegationTasks: {
          ...instances.get("agy")?.adapter?.state().params.delegationTasks,
          ...delegation.snapshot().pending,
        },
        activeTurns: merge("activeTurns"),
        queuedInputs: merge("queuedInputs"),
        executionStatuses: merge("executionStatuses"),
        compactions: merge("compactions"),
        terminals: { ...merge("terminals"), ...workspace.snapshot() },
        undoneFiles: states.flatMap((s) => s.undoneFiles),
      },
    };
  }
  function emitState() {
    if (!closed) broadcast(state());
  }
  async function install(backend) {
    const entry = { backend, adapter: null, error: null, proxies: new Map() };
    instances.set(backend.id, entry);
    const deps =
      backend.id === "agy"
        ? {}
        : bindConversationTools(
            conversations,
            entry,
            folders,
            () => !closed,
            (name, actor, args) =>
              delegation.invoke(backend, name, actor, args),
          );
    if (!backend.enabled) return;
    try {
      const factory = factories[backend.type] || adapterFactories[backend.type];
      entry.adapter = factory({
        ...deps,
        backend,
        config,
        background,
        backgroundEnabled: () =>
          entry.backend.backgroundTerminalEnabled && background.available,
        version,
        providers,
        ...(deps?.conversationToolEndpoint &&
          backend.id === "codex" && {
            readSecretaryRole: async (threadId, selected) => {
              const enabled =
                selected ??
                (threadId &&
                  (await delegationModes.enabled(backend, threadId)));
              if (enabled)
                return resolveNativeSecretaryRole(
                  instances.get("agy").backend,
                  backend.id,
                );
            },
          }),
        readSubagentSettings: () =>
          configuration.readSubagentSettings(backend.id),
        send: (client, message) => client.deliver(message),
        broadcast(message) {
          if (instances.get(backend.id) !== entry || closed) return;
          if (message.method === "lan/state") {
            if (entry.adapter?.ready) entry.error = null;
            usageReconciliation.start(entry);
            return emitState();
          }
          const notification = mapNotification(message, backend.id);
          tokenUsage.observe(notification);
          broadcast(notification);
        },
      });
      await entry.adapter.connect();
      usageReconciliation.start(entry);
    } catch (error) {
      entry.error = error.message;
    }
  }
  async function connect() {
    await Promise.all([folders.read(), background.bindExistingTasks()]);
    const data = await configuration.read();
    await Promise.all(data.backends.map(install));
    await delegation.start();
    initialized = true;
    cli.start?.();
    emitState();
  }
  function instance(id) {
    const entry = instances.get(id);
    if (entry?.changing) throw new Error("后端配置正在更新，请稍后重试。");
    if (!entry?.adapter)
      throw new Error(entry?.error || "后端未启用，请在设置中检查配置。");
    return entry;
  }
  async function projectResult(
    entry,
    result,
    method,
    usageRevision,
    forkUsage,
    selectedMode,
  ) {
    const projected = await tokenUsage.result(
      folders.result(
        mapResult(
          await modeRequests.project(
            entry.backend,
            method,
            result,
            selectedMode,
          ),
          entry.backend.id,
          method,
        ),
        method,
      ),
      method,
      usageRevision,
      forkUsage,
      entry.adapter.readTokenUsage,
    );
    return method === "thread/list" && entry.backend.id !== "agy"
      ? hideDelegatedThreads(projected)
      : projected;
  }
  async function saveBackend(params, prepare) {
    validateBackend(params, config);
    const old = instances.get(params.id);
    const next = validateBackend({ ...old?.backend, ...params }, config);
    const preference = isBackendPreference(params);
    if (!preference) await validateSubagentSettings(next, providers);
    if (
      params.backgroundTerminalEnabled === true &&
      !old?.backend.backgroundTerminalEnabled
    )
      await background.ensure();
    if (!prepare && isAgyPreference(params)) {
      old.backend = await configuration.save(params);
      await old.adapter?.configure?.(old.backend);
      emitState();
      return { backends: publicBackends() };
    }
    if (!prepare && (preference || isSubagentSettings(params))) {
      old.backend = await configuration.save(params);
      emitState();
      return { backends: publicBackends() };
    }
    const snapshot = old?.adapter?.state().params;
    if (hasBackendWork(snapshot))
      throw new Error("请等待此后端的任务结束后修改配置。");
    if (old) old.changing = true;
    try {
      await old?.adapter?.shutdown?.();
      if (prepare) await prepare();
      if (closed) return { backends: publicBackends() };
      const backend = await configuration.save(params);
      old?.adapter?.close();
      await install(backend);
    } catch (error) {
      if (old && !closed) {
        old.changing = false;
        if (!old.adapter?.ready) {
          old.adapter?.close();
          await install(old.backend);
        }
      }
      throw error;
    }
    emitState();
    return { backends: publicBackends() };
  }
  async function receive(client, message) {
    await folders.read();
    const method = message.method,
      params = message.params || {};
    const reply = (result) => send(client, { id: message.id, result });
    if (method?.startsWith("lan/terminal/"))
      return reply(await workspace.request(method, params));
    const fallback =
      params.threadId != null
        ? "codex"
        : params.backendId || state().params.defaultBackendId;
    const target = resourceTarget(
      params.threadId ?? params.processId ?? (!method ? message.id : null),
      fallback,
    );
    if (method === "lan/thread/move") {
      const entry = instance(target.backendId);
      const { thread } = await call(entry, "thread/read", {
        threadId: target.nativeId,
        includeTurns: false,
      });
      const moved = await folders.move(thread, params.folderPath);
      broadcast({ method: "thread/folder/updated", params: { thread: moved } });
      return reply({ thread: moved });
    }
    if (method === "lan/projectless/read")
      return reply({
        directories: await readProjectlessDirectories(
          instances.get("codex")?.backend.dataDir || config.codexHome,
        ),
      });
    if (method === "lan/backends/versions" && !instances.has(params.id))
      throw new Error("未知后端");
    if (["lan/backends/list", "lan/backends/versions"].includes(method))
      return reply({ backends: publicBackends() });
    if (method === "lan/backends/agy/role/read")
      return reply(await readAgyRole(agyStateDirectory(config.configDir)));
    if (method === "lan/backends/agy/role/save")
      return reply(
        await saveAgyRole(agyStateDirectory(config.configDir), params.content),
      );
    if (method === "lan/backends/install") {
      if (params.id === "agy")
        throw new Error("Antigravity CLI 由系统环境提供");
      const entry = instances.get(params.id);
      if (!entry) throw new Error("未知后端");
      if (!installationJobs.has(params.id)) {
        installationErrors.delete(params.id);
        const operation = changing.then(() =>
          saveBackend(instances.get(params.id).backend, () =>
            cli.install(params.id),
          ),
        );
        installationJobs.set(params.id, operation);
        changing = operation.catch(() => {});
        operation
          .catch((error) => installationErrors.set(params.id, error.message))
          .finally(() => {
            installationJobs.delete(params.id);
            emitState();
          });
        emitState();
      }
      return reply({ backends: publicBackends() });
    }
    if (
      [
        "lan/backends/save",
        "lan/backends/disable",
        "lan/backends/check",
      ].includes(method)
    ) {
      const input =
        method === "lan/backends/save"
          ? params
          : {
              ...instances.get(params.id)?.backend,
              ...(method.endsWith("disable") && { enabled: false }),
            };
      const operation = changing.then(() => saveBackend(input));
      changing = operation.catch(() => {});
      return reply(await operation);
    }
    const providerOperation = providers.request(method, params);
    if (providerOperation) return reply(await providerOperation);
    if (method === "thread/list" && !params.backendId)
      return reply(
        await listBackendThreads(params, { instances, instance, call }),
      );
    const operation = delegationRequest(delegation, method, params, target);
    if (operation) return reply(await operation);
    const entry = instance(target.backendId);
    if (workspace.handles(method, entry.backend, entry.adapter.workspaceOwner))
      return reply(await workspace.request(method, params, entry.backend));
    const recipient = proxy(entry, client);
    const forkUsage = method === "thread/fork" && target.backendId !== "agy";
    if (forkUsage && !(await tokenUsage.forkSource(params)))
      await call(entry, "thread/read", {
        threadId: target.nativeId,
        includeTurns: false,
      });
    const native =
      method && nativeParams(folders.params(method, params), entry.backend.id);
    if (method === "lan/delegation/mode/set")
      return reply(await modeRequests.set(entry, native, call));
    const { forwarded, selectedMode } = modeRequests.forward(
      entry.backend,
      method,
      native,
    );
    recipient.methods.set(message.id, {
      method,
      threadId: params.threadId,
      usageRevision: tokenUsage.revision(params.threadId),
      selectedMode,
      ...(forkUsage && {
        forkUsage: await tokenUsage.forkSource(params),
      }),
    });
    try {
      await entry.adapter.receive(recipient, {
        ...message,
        ...(!method && { id: target.nativeId }),
        ...(method && { params: forwarded }),
      });
    } catch (error) {
      recipient.methods.delete(message.id);
      throw error;
    }
  }
  function releaseClient(client) {
    for (const entry of instances.values()) {
      const recipient = entry.proxies.get(client);
      entry.proxies.delete(client);
      if (recipient) entry.adapter?.releaseClient(recipient);
    }
  }
  return {
    state,
    receive,
    connect,
    releaseClient,
    releaseUnusedThreads() {
      for (const i of instances.values()) i.adapter?.releaseUnusedThreads();
    },
    maintenanceState() {
      const { params } = state();
      return {
        method: "lan/state",
        params: {
          ready: initialized,
          activeTurns: params.activeTurns,
          compactions: params.compactions,
          delegationTasks: params.delegationTasks,
          installingBackends: [...installationJobs.keys()],
          tokenUsageReconciliation: usageReconciliation.snapshot(),
        },
      };
    },
    close() {
      closed = true;
      delegation.close();
      usageReconciliation.stop();
      cli.close?.();
      workspace.close();
      for (const i of instances.values()) i.adapter?.close();
      return usageReconciliation.flush().then(() => tokenUsage.flush());
    },
    get ready() {
      return state().params.ready;
    },
  };
}
