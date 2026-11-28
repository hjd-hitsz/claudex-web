import React from "react";
import { AlertCircle } from "lucide-react";
import {
  secretaryHistoryScope,
  setComposerDelegation,
} from "./delegation-toggle.jsx";

export function SecretaryUpgrade({ disabled }) {
  return (
    <section className="composer-access" aria-label="旧版秘书对话">
      <AlertCircle size={20} aria-hidden="true" />
      <div className="composer-access-content">
        <strong>此旧版秘书对话需要先转换</strong>
        <p>{secretaryHistoryScope}</p>
        <div className="secretary-upgrade-actions">
          <button
            className="primary"
            disabled={disabled}
            onClick={() =>
              setComposerDelegation({
                delegationMode: true,
                mode: "default",
                goalMode: false,
              })
            }
          >
            转换为干净秘书续接
          </button>
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => setComposerDelegation({ delegationMode: false })}
          >
            恢复普通模式
          </button>
        </div>
      </div>
    </section>
  );
}
