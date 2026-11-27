import React from "react";
import { MessageSquare } from "lucide-react";
import { openThread, titleOf } from "../store.js";
import {
  isThreadRunning,
  runningThreadLabel,
  sidebarProjectGroups,
} from "../domain/thread-order.js";
import { resourceTarget } from "../../../shared/backend-identity.mjs";
import { BackendBadge } from "../features/backends/backend-badge.jsx";
import { HeaderSwitcher } from "./header-switcher.jsx";
import { ThreadRunningIcon } from "./thread-running-icon.jsx";

export function ConversationSwitcher({ state, path }) {
  const label = titleOf(state.current);
  return (
    <HeaderSwitcher
      as="span"
      className="conversation-switcher"
      label={label}
      triggerLabel={`切换对话，当前为 ${label}`}
      groupLabel="当前分组的对话"
      compactIcon={
        <MessageSquare
          className="switcher-compact-icon"
          size={14}
          aria-hidden="true"
        />
      }
      emptyLabel="此分组暂无对话"
      current={state.current?.id}
      getOptions={() => {
        const groups = sidebarProjectGroups(state, { includePinned: true });
        const threads = groups.find(([folder]) => folder === path)?.[1] || [];
        const hasRunning = threads.some((thread) =>
          isThreadRunning(thread, state),
        );
        return threads.map((thread) => {
          const running = isThreadRunning(thread, state);
          const description = running
            ? runningThreadLabel(thread, state)
            : "已结束";
          return {
            value: thread.id,
            label: titleOf(thread),
            description,
            icon: (
              <span className="conversation-switcher-icons">
                {hasRunning && (
                  <span
                    className="conversation-switcher-status"
                    title={running ? description : undefined}
                  >
                    {running && <ThreadRunningIcon />}
                  </span>
                )}
                <BackendBadge backendId={resourceTarget(thread.id).backendId} />
              </span>
            ),
          };
        });
      }}
      onSelect={openThread}
    />
  );
}
