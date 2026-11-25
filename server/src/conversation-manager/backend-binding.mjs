import { resourceId } from "../../../shared/backend-identity.mjs";

export function bindConversationTools(manager, entry, folders, isOpen) {
  const { backend } = entry;
  return manager?.bindBackend(
    backend,
    () =>
      isOpen() &&
      !entry.changing &&
      entry.adapter?.ready &&
      entry.adapter.conversationManager,
    (thread) =>
      folders.project({
        ...thread,
        id: resourceId(backend.id, thread.threadId),
      }),
  );
}
