import { resourceTarget } from "../../../shared/backend-identity.mjs";
export function currentBackendId(state) {
  return state.current
    ? resourceTarget(state.current.id).backendId
    : state.backendId || "codex";
}
export function backendCapability(state, name) {
  const backend = state.backends?.find((b) => b.id === currentBackendId(state));
  return backend?.capabilities?.[name] ?? false;
}
export function backendReady(state) {
  const backend = state.backends?.find((b) => b.id === currentBackendId(state));
  return backend ? backend.ready : state.connected;
}
export function modelVisibilityKey(model, providerId = "") {
  return providerId ? JSON.stringify([providerId, model]) : model;
}
export function isModelHidden(backend, model, providerId) {
  return (
    backend?.hiddenModels?.includes(modelVisibilityKey(model, providerId)) ??
    false
  );
}
export function modelChoiceLabel({ providerName, displayName, model }) {
  const name = displayName || model;
  return providerName && name ? providerName + "/" + name : name;
}
export function modelProviderName(choices, backendId, providerId) {
  if (!providerId || providerId === "@native")
    return { claude: "Claude", agy: "Antigravity" }[backendId] || "ChatGPT";
  return (
    choices?.find(
      (entry) =>
        entry.backendId === backendId && entry.providerId === providerId,
    )?.providerName || providerId
  );
}
