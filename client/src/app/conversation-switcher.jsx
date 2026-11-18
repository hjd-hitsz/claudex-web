import React from "react";
import { MessageSquare } from "lucide-react";
import { openThread, titleOf } from "../store.js";
import { sidebarProjectGroups } from "../domain/thread-order.js";
import { resourceTarget } from "../../../shared/backend-identity.mjs";
import { BackendBadge } from "./backend-badge.jsx";
import { HeaderSwitcher } from "./header-switcher.jsx";

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
        return threads.map((thread) => ({
          value: thread.id,
          label: titleOf(thread),
          icon: (
            <BackendBadge backendId={resourceTarget(thread.id).backendId} />
          ),
        }));
      }}
      onSelect={openThread}
    />
  );
}
