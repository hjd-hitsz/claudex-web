import React from "react";
import antigravityIcon from "../../assets/antigravity.svg";
import claudeIcon from "../../assets/claude.svg";
import openaiIcon from "../../assets/openai.svg";

export function BackendBadge({ backendId }) {
  const icon = backendId === "claude" ? claudeIcon : openaiIcon;
  return (
    <span className="backend-badge" data-backend={backendId} aria-hidden="true">
      {backendId === "agy" ? (
        <img src={antigravityIcon} alt="" />
      ) : (
        <span
          className="backend-symbol"
          aria-hidden="true"
          style={{ maskImage: `url("${icon}")` }}
        />
      )}
    </span>
  );
}
