import React from "react";
import { findCodeLine, set, useStoreSelector } from "../../store.js";
import { MarkdownEditor } from "./markdown-editor.jsx";

function openReference({ kind, path }) {
  set({ panel: "files", panelFile: { kind, path } });
}

export function ReferenceEditor(props) {
  const skills = useStoreSelector((state) => state.skills);
  return (
    <MarkdownEditor
      {...props}
      referenceSkills={skills}
      onOpenReference={openReference}
      findCodeLine={findCodeLine}
    />
  );
}
