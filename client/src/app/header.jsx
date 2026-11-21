import { ServiceUpdateEntry } from "../features/settings/service-maintenance.jsx";
import React from "react";

import { PanelLeft, Plus, MoreHorizontal } from "lucide-react";
import { useStore, newChat } from "../store.js";
import { IconButton } from "../ui/primitives.jsx";
import { useDismissibleMenu } from "../ui/dismissible-menu.js";
import { BackendBadge } from "../features/backends/backend-badge.jsx";
import { currentBackendId } from "../domain/backends.js";
import { ThreadMenu } from "./thread-row.jsx";
import { ProjectSwitcher } from "./project-switcher.jsx";
import { ConversationSwitcher } from "./conversation-switcher.jsx";
export function Header({ sidebarOpener, onShowSidebar, onShowMaintenance }) {
  const s = useStore();
  const menu = useDismissibleMenu();
  const path = s.projectless ? "" : s.cwd;
  return (
    <header className="topbar">
      <IconButton
        icon={PanelLeft}
        title="显示侧栏"
        aria-controls="project-sidebar"
        ref={sidebarOpener}
        onClick={onShowSidebar}
      />
      <BackendBadge backendId={currentBackendId(s)} />
      <div className="breadcrumb">
        <ProjectSwitcher state={s} path={path} />
        <ConversationSwitcher state={s} path={path} />
        {s.current && (
          <div className="header-menu" {...menu.scopeProps}>
            <IconButton
              icon={MoreHorizontal}
              title="对话操作"
              {...menu.triggerProps}
            />
            {menu.open && (
              <ThreadMenu
                thread={s.current}
                onClose={menu.close}
                {...menu.menuProps}
              />
            )}
          </div>
        )}
      </div>
      <div className="topbar-actions">
        <ServiceUpdateEntry compact onOpen={onShowMaintenance} />
        <IconButton
          icon={Plus}
          title="在当前目录新建对话"
          onClick={() => newChat(undefined, { reuseDirectory: true })}
        />
      </div>
    </header>
  );
}
