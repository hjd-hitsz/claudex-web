import React from "react";
import { openThread, set, useStoreSelector } from "../../store.js";
import { localImagePath } from "../../domain/image-source.js";
import { pathIcon } from "../../ui/path-icon.jsx";
import {
  inlineReference,
  referencePath,
  skillReferenceDisplayName,
} from "../../domain/inline-references.js";
import { InlineReference } from "../../ui/inline-reference.jsx";
import { useMarkdownDirectory } from "./use-markdown-directory.js";

function labelText(node) {
  return node.type === "text"
    ? node.value
    : (node.children || []).map(labelText).join("");
}

export function MessageLink({
  href,
  title,
  children,
  node,
  cwd: baseDirectory,
}) {
  const directory = useMarkdownDirectory(baseDirectory);
  const imageOnly = node?.children?.every(
    (child) =>
      child.tagName === "img" || (child.type === "text" && !child.value.trim()),
  );
  const reference = inlineReference(
    referencePath(href),
    node ? labelText(node) : String(children),
    title,
  );
  const displayName = useStoreSelector((state) =>
    skillReferenceDisplayName(reference, state.skills),
  );
  if (reference?.kind === "skill") reference.displayName = displayName;
  if (reference && !imageOnly)
    return (
      <InlineReference
        reference={reference}
        onOpen={() =>
          reference.kind === "thread"
            ? openThread(reference.threadId)
            : reference.path.startsWith("skill://")
              ? set({ modal: { type: "skills" } })
              : set({
                  panel: "files",
                  panelFile: {
                    kind: reference.kind === "directory" ? "directory" : "file",
                    path: reference.path,
                  },
                })
        }
      />
    );
  const Icon = pathIcon(
    (href || "").replace(/^file:\/\/(?:localhost)?(?=\/)|^sandbox:(?=\/)/i, ""),
  );
  if (href && !href.startsWith("#"))
    href = localImagePath(href, directory) || href;
  return (
    <a
      className="message-link"
      href={href}
      title={title || href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (href?.startsWith("#")) {
          event.preventDefault();
          const root =
            event.currentTarget.closest(".file-markdown-preview") ||
            event.currentTarget.closest(".markdown");
          let id;
          try {
            id = decodeURIComponent(href.slice(1));
          } catch {
            id = href.slice(1);
          }
          const target = id
            ? [...(root?.querySelectorAll("[id]") || [])].find(
                (element) =>
                  element.id === id || element.id === "user-content-" + id,
              )
            : root;
          if (target) {
            let parent = target.parentElement;
            while (parent && parent !== root) {
              if (parent.tagName === "DETAILS") parent.open = true;
              parent = parent.parentElement;
            }
            target.scrollIntoView({ block: "start" });
          }
        } else if (href?.startsWith("/") && !href.startsWith("//")) {
          event.preventDefault();
          set({
            panel: "files",
            panelFile: {
              kind: "file",
              path: href.replace(/:\d+(?::\d+)?$/, ""),
            },
          });
        }
      }}
    >
      {href && !imageOnly && (
        <Icon
          className="message-link-icon"
          aria-hidden="true"
          focusable="false"
        />
      )}
      {children}
    </a>
  );
}
