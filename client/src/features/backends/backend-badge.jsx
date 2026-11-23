import React from "react";
import claudeIcon from "../../assets/claude.svg";
import opencodeIcon from "../../assets/opencode.svg";
import openaiIcon from "../../assets/openai.svg";

export function BackendBadge({ backendId }) {
  const icon =
    { claude: claudeIcon, codex: openaiIcon, opencode: opencodeIcon }[
      backendId
    ] || openaiIcon;
  return (
    <span className="backend-badge" data-backend={backendId} aria-hidden="true">
      <span
        className="backend-symbol"
        aria-hidden="true"
        style={{ maskImage: `url("${icon}")` }}
      />
    </span>
  );
}
