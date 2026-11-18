import { ServiceUpdateEntry } from "./service-maintenance.jsx";
import React, { useState } from "react";

import { PanelLeft, Plus, MoreHorizontal } from "lucide-react";
import { useStore, set, newChat } from "../store.js";
import { IconButton } from "../ui/primitives.jsx";
import { BackendBadge } from "./backend-badge.jsx";
import { currentBackendId } from "../domain/backends.js";
import { ThreadMenu } from "./thread-row.jsx";
import { ProjectSwitcher } from "./project-switcher.jsx";
import { ConversationSwitcher } from "./conversation-switcher.jsx";
export function Header() {
  const s = useStore(),
    [menu, show] = useState(false);
  const path = s.projectless ? "" : s.cwd;
  return (
    <header className="topbar">
      <IconButton
        icon={PanelLeft}
        title="显示侧栏"
        onClick={() => {
          document.body.classList.remove("sidebar-collapsed");
          set({ sidebar: !s.sidebar });
        }}
      />
      <BackendBadge backendId={currentBackendId(s)} />
      <div className="breadcrumb">
        <ProjectSwitcher state={s} path={path} />
        <ConversationSwitcher state={s} path={path} />
        {s.current && (
          <div className="header-menu">
            <IconButton
              icon={MoreHorizontal}
              title="对话操作"
              onClick={() => show(!menu)}
            />
            {menu && (
              <>
                <div className="click-away" onClick={() => show(false)} />
                <ThreadMenu thread={s.current} onClose={() => show(false)} />
              </>
            )}
          </div>
        )}
      </div>
      <div className="topbar-actions">
        <ServiceUpdateEntry compact />
        <IconButton
          icon={Plus}
          title="在当前目录新建对话"
          onClick={() => newChat(undefined, { reuseDirectory: true })}
        />
      </div>
    </header>
  );
}
