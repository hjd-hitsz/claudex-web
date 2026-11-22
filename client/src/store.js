import { useSyncExternalStore } from "react";
import { createApplication } from "./application/create-application.js";
export {
  uid,
  basename,
  titleOf,
  b64decode,
  b64encode,
} from "./domain/format.js";
export { persist } from "./infrastructure/storage.js";
const application = createApplication();
export const {
  activateBackend,
  selectModelChoice,
  selectProvider,
  refreshBackends,
  saveBackend,
  saveProvider,
  removeProvider,
  setReadingThread,
  openSubAgent,
  selectModel,
  selectEffort,
  syncProjectModels,
  onEvent,
  refreshGoal,
  updateGoal,
  submitGoal,
  report,
  trackFeedback,
  notice,
  listThreads,
  rpc,
  refreshUsage,
  setThinkingTranslation,
  setCompletionNotifications,
  startNotifications,
  startTranslationSettings,
  respond,
  loadThreads,
  setDraft,
  setProjectDirectory,
  newChat,
  openThread,
  refreshThreadAccess,
  loadHistory,
  refreshBackgroundResults,
  ensureThread,
  sendMessage,
  approvePlan,
  stop,
  rename,
  archive,
  deleteThread,
  fork,
  compact,
  refreshCompaction,
  review,
  loadSkills,
  pin,
  addProject,
  toggleProjectPin,
  moveThreadToFolder,
  addAttachment,
  attachFile,
  cancelMessageEdit,
  copy,
  applySession,
  checkSession,
  login,
  verifyTotp,
  logout,
} = application;
export const { get, set } = application.store;
export function useStore() {
  return useSyncExternalStore(
    application.store.subscribe,
    application.store.sharedSnapshot,
  );
}
// Select a primitive or an existing reference from the shared snapshot.
export function useStoreSelector(select) {
  return useSyncExternalStore(application.store.subscribe, () =>
    select(application.store.sharedSnapshot()),
  );
}
export function useDraft() {
  return useSyncExternalStore(
    application.store.subscribeDraft,
    application.store.draftSnapshot,
  );
}
