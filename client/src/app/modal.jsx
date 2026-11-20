import { ResizableDialog } from "../ui/surface-resize.jsx";
import React, { useEffect } from "react";

import { X } from "lucide-react";
import {
  useStore,
  set,
  setProjectDirectory,
  newChat,
  addProject,
} from "../store.js";
import { IconButton } from "../ui/primitives.jsx";
import { FolderPicker } from "../features/workspace/folder-picker.jsx";
import {
  CommandDialog,
  commandTitles,
} from "../features/commands/command-dialog.jsx";
import { SearchDialog, RenameDialog, DeleteDialog } from "./thread-dialogs.jsx";

import { SettingsDialog } from "../features/settings/settings-dialog.jsx";
import { ModelDialog } from "../features/composer/model-dialog.jsx";
import { LogoutButton } from "./auth.jsx";

import { SkillsDialog, PluginsDialog } from "./tool-dialogs.jsx";

export function Modal() {
  const s = useStore();
  useEffect(() => {
    if (
      s.modal?.type === "command" &&
      s.modal.thread &&
      s.modal.thread.id !== s.current?.id
    )
      set({ modal: null });
  }, [s.current?.id, s.modal]);
  if (!s.modal) return null;
  const { type } = s.modal;
  const dismiss = () => set({ modal: null });
  const titles = {
    command: commandTitles[s.modal.view],
    search: "搜索对话",
    rename: "重命名对话",
    delete: "删除对话",
    directory: "选择工作目录",
    project: "添加项目",
    skills: "技能",
    plugins: "插件与连接",
    settings: "设置",
    model: "模型与思考强度",
  };
  return (
    <ResizableDialog
      key={type + (s.modal.view || "")}
      resizeId={type + (s.modal.view ? ":" + s.modal.view : "")}
      className={"modal modal-" + type}
      aria-label={titles[type]}
      onDismiss={dismiss}
    >
      <div className="modal-heading">
        <h2>{titles[type]}</h2>
        <IconButton icon={X} title="关闭窗口" onClick={dismiss} />
      </div>
      {type === "command" ? (
        <div
          className="command-dialog"
          key={s.modal.view + (s.modal.thread?.id || "")}
        >
          <CommandDialog modal={s.modal} />
        </div>
      ) : type === "delete" ? (
        <DeleteDialog thread={s.modal.thread} />
      ) : type === "model" ? (
        <ModelDialog onClose={dismiss} />
      ) : type === "search" ? (
        <SearchDialog />
      ) : type === "rename" ? (
        <RenameDialog thread={s.modal.thread} />
      ) : type === "skills" ? (
        <SkillsDialog />
      ) : type === "plugins" ? (
        <PluginsDialog />
      ) : type === "settings" ? (
        <SettingsDialog
          focusMaintenance={s.modal.section === "maintenance"}
          accountActions={<LogoutButton />}
        />
      ) : (
        <FolderPicker
          onChoose={(path) => {
            if (type === "project") addProject(path);
            else if (s.current) newChat(path);
            else setProjectDirectory(path);
            dismiss();
          }}
        />
      )}
    </ResizableDialog>
  );
}
