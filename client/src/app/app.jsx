import { ServiceUpdateNotice } from "../features/settings/service-maintenance.jsx";
import { ExecutionError } from "../features/conversation/execution-error.jsx";
import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Check, LoaderCircle } from "lucide-react";
import {
  useStoreSelector,
  get,
  set,
  setReadingThread,
  newChat,
  startTranslationSettings,
} from "../store.js";
import { Conversation } from "../features/conversation/conversation.jsx";
import { Composer } from "../features/composer/composer.jsx";
import { ContextWorkspace } from "../features/workspace/context-panel.jsx";
import { BackgroundTaskProvider } from "../features/background-tasks/background-task-provider.jsx";
import { Sidebar } from "./sidebar.jsx";
import { Header } from "./header.jsx";
import { Modal } from "./modal.jsx";
import { listenForMarkdownCopy } from "../features/markdown/markdown-selection.js";
const TerminalPanel = lazy(() =>
  import("../features/workspace/terminal-panel.jsx").then((module) => ({
    default: module.TerminalPanel,
  })),
);

function showMaintenance() {
  set({ modal: { type: "settings", section: "maintenance" } });
}

const portraitQuery = "(orientation: portrait)";

function subscribeToOrientation(onChange) {
  const media = window.matchMedia(portraitQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isPortrait() {
  return window.matchMedia(portraitQuery).matches;
}

export function App() {
  return (
    <BackgroundTaskProvider>
      <AppShell />
    </BackgroundTaskProvider>
  );
}

function AppShell() {
  useEffect(() => startTranslationSettings(), []);
  useEffect(listenForMarkdownCopy, []);
  const drawerOpen = useStoreSelector((state) => state.sidebar);
  const settingsOpen = useStoreSelector(
    (state) => state.modal?.type === "settings",
  );
  const connected = useStoreSelector((state) => state.connected);
  const terminalOpen = useStoreSelector((state) => state.terminalOpen);
  const notice = useStoreSelector((state) => state.notice);
  const theme = useStoreSelector((state) => state.theme);
  const readingId = useStoreSelector((state) =>
    !state.loading && state.threadAccess?.status !== "loadError"
      ? state.current?.id
      : null,
  );
  const portrait = useSyncExternalStore(subscribeToOrientation, isPortrait);
  const orientation = portrait ? "portrait" : "landscape";
  const [sidebarByOrientation, setSidebarByOrientation] = useState({});
  const desktopSidebarCollapsed = sidebarByOrientation[orientation] ?? portrait;
  const focusSidebarOnClose = useRef(false);
  const sidebarOpener = useRef(null);
  const contextToggle = useRef(null);
  const composerInput = useRef(null);
  const focusComposer = useCallback(() => composerInput.current?.focus(), []);

  // 侧栏交互与布局共用容器断点，页面缩放时沿用相同的收放模式。
  function usesDrawer() {
    return (
      getComputedStyle(sidebarOpener.current)
        .getPropertyValue("--sidebar-mode")
        .trim() === "drawer"
    );
  }

  function closeDrawer() {
    set({ sidebar: false });
    sidebarOpener.current?.focus({ preventScroll: true });
  }

  function setDesktopSidebarCollapsed(collapsed) {
    setSidebarByOrientation((current) => ({
      ...current,
      [orientation]: collapsed,
    }));
  }

  function closeSidebar() {
    if (usesDrawer()) closeDrawer();
    else {
      focusSidebarOnClose.current = true;
      setDesktopSidebarCollapsed(true);
    }
  }

  function showSidebar() {
    if (usesDrawer()) set({ sidebar: !get().sidebar });
    else setDesktopSidebarCollapsed(false);
  }

  useLayoutEffect(() => {
    if (
      desktopSidebarCollapsed &&
      !usesDrawer() &&
      (focusSidebarOnClose.current ||
        document.activeElement?.closest("#project-sidebar"))
    )
      sidebarOpener.current?.focus({ preventScroll: true });
    focusSidebarOnClose.current = false;
  }, [desktopSidebarCollapsed]);

  useEffect(() => {
    const read = () =>
      setReadingThread(
        document.visibilityState === "hidden" ? null : readingId,
      );
    read();
    document.addEventListener("visibilitychange", read);
    return () => {
      document.removeEventListener("visibilitychange", read);
      setReadingThread(null);
    };
  }, [readingId]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape") {
        const state = get();
        if (e.defaultPrevented || state.modal) return;
        if (state.sidebar && usesDrawer()) closeDrawer();
        else if (state.contextOpen) {
          set({ contextOpen: false });
          contextToggle.current?.focus({ preventScroll: true });
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        set({ modal: { type: "search" } });
      }
      if (e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newChat();
      }
      if (e.key === "`") {
        e.preventDefault();
        set({ terminalOpen: !get().terminalOpen });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div
      className={
        "app-shell" + (desktopSidebarCollapsed ? " sidebar-collapsed" : "")
      }
    >
      <Sidebar
        drawerOpen={drawerOpen}
        onClose={closeSidebar}
        onShowMaintenance={showMaintenance}
      />
      <main className="main-shell">
        <Header
          sidebarOpener={sidebarOpener}
          onShowSidebar={showSidebar}
          onShowMaintenance={showMaintenance}
        />
        <ServiceUpdateNotice settingsOpen={settingsOpen} />
        {!connected && (
          <div className="connection-banner">
            <LoaderCircle size={14} className="spin" />
            正在连接…
          </div>
        )}
        <div className="workspace">
          <section className="chat-pane">
            <Conversation
              focusComposer={focusComposer}
              footer={
                <div className="conversation-footer" key="composer">
                  <ExecutionError />
                  <Composer inputRef={composerInput} />
                </div>
              }
            >
              <ContextWorkspace toggleRef={contextToggle} />
            </Conversation>
          </section>
        </div>
        {terminalOpen && (
          <Suspense fallback={<div className="loading">正在打开终端…</div>}>
            <TerminalPanel />
          </Suspense>
        )}
      </main>
      <Modal />
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
    </div>
  );
}
export class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h2>页面遇到错误</h2>
        <button onClick={() => location.reload()}>重新载入</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
