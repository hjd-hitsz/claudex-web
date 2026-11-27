import React, { createContext } from "react";
import { useStoreSelector } from "../../store.js";
import { useBackgroundTasks } from "./use-background-tasks.js";
import { useConversationActivity } from "./use-conversation-activity.js";

export const BackgroundTasks = createContext({ tasks: [] });

export function BackgroundTaskProvider({ children }) {
  useConversationActivity();
  const threadId = useStoreSelector((state) =>
    !state.loading && state.threadAccess?.status !== "loadError"
      ? state.current?.id
      : null,
  );
  const enabled = useStoreSelector(
    (state) =>
      state.connected &&
      (state.current?.backendId === "claude" ||
        state.backends.some(
          (backend) =>
            backend.id === "codex" && backend.backgroundTerminalAvailable,
        )),
  );
  const tasks = useBackgroundTasks(threadId, enabled);
  return (
    <BackgroundTasks.Provider value={tasks}>
      {children}
    </BackgroundTasks.Provider>
  );
}
