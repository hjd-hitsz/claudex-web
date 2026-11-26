import React from "react";

export function DelegationContext({ context }) {
  if (!context) return null;
  const tokens = (value) => value?.toLocaleString() ?? "—";
  const { usedTokens, totalTokens, compactCount } = context;
  const share =
    totalTokens && usedTokens !== undefined
      ? ((100 * usedTokens) / totalTokens).toFixed(1) + "%"
      : "";
  return (
    <dl className="delegation-context" aria-label="执行端上下文">
      <div>
        <dt>上下文</dt>
        <dd>
          {tokens(usedTokens)} / {tokens(totalTokens)} Token
          {share && `（${share}）`}
        </dd>
      </div>
      {compactCount !== undefined && (
        <div>
          <dt>压缩</dt>
          <dd>{tokens(compactCount)} 次</dd>
        </div>
      )}
    </dl>
  );
}
