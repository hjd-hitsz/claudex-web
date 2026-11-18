import React from "react";
import { Folder, MessageSquare } from "lucide-react";
import { basename, newChat } from "../store.js";
import { sidebarProjectGroups } from "../domain/thread-order.js";
import { HeaderSwitcher } from "./header-switcher.jsx";

const projectLabel = (path) => (path ? basename(path) : "未分类");

export function ProjectSwitcher({ state, path }) {
  const label = projectLabel(path);
  return (
    <HeaderSwitcher
      className="project-switcher"
      label={label}
      triggerLabel={`切换项目文件夹，当前为 ${label}`}
      groupLabel="项目文件夹"
      title={path || label}
      compactIcon={
        <Folder
          className="switcher-compact-icon"
          size={14}
          aria-hidden="true"
        />
      }
      emptyLabel="暂无有对话的文件夹"
      current={path}
      getOptions={() => {
        const groups = sidebarProjectGroups(state, { includePinned: true })
          .filter(([, threads]) => threads.length > 0)
          .map(([value]) => ({ value, label: projectLabel(value) }));
        const labelCounts = new Map();
        for (const { label } of groups)
          labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
        return groups.map((option) => {
          const Icon = option.value ? Folder : MessageSquare;
          return {
            ...option,
            title: option.value,
            detail: labelCounts.get(option.label) > 1 ? option.value : "",
            icon: <Icon size={15} aria-hidden="true" />,
          };
        });
      }}
      onSelect={newChat}
    />
  );
}
