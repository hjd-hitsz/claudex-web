import React, { createContext } from "react";
import { useStore } from "../../store.js";
import { useBackgroundTasks } from "./use-background-tasks.js";

export const BackgroundTasks = createContext({ tasks: [] });

export function BackgroundTaskProvider({ children }) {
  const s = useStore();
  const threadId =
    !s.loading && s.threadAccess?.status !== "loadError" ? s.current?.id : null;
  const tasks = useBackgroundTasks(
    threadId,
    s.connected &&
      (s.current?.backendId === "claude" ||
        s.backends.some(
          (backend) =>
            backend.id === "codex" && backend.backgroundTerminalAvailable,
        )),
  );
  return (
    <BackgroundTasks.Provider value={tasks}>
      {children}
    </BackgroundTasks.Provider>
  );
}
