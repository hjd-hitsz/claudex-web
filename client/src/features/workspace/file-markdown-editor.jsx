import React, { useRef } from "react";
import { MarkdownEditor } from "../composer/markdown-editor.jsx";
import { fileDocumentViews } from "./file-document-views.jsx";

export function FileMarkdownEditor({ path, text, onChange }) {
  const inputRef = useRef();
  const cwd = path.slice(0, path.lastIndexOf("/")) || "/";
  return (
    <div className="file-markdown-preview">
      <MarkdownEditor
        inputRef={inputRef}
        value={text}
        file
        fill
        configure={(editor) => editor.use(fileDocumentViews(cwd))}
        aria-label="Markdown 文件预览"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
