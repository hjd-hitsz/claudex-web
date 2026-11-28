import React, { useId, useState } from "react";
import {
  delegationSnippet,
  deliveryCardPreviewLimit,
  deliverySnippet,
} from "../../../../shared/delivery-summary.mjs";
import { RichText } from "../markdown/rich-text.jsx";
import { DeliverySummary } from "./delivery-summary.jsx";

export function PeerMessage({ item, cwd }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const title = item.from.title?.trim() || "未命名会话";
  const kind = item.replyTo ? "会话回复" : "会话请求";
  return (
    <div className="peer-message">
      <DeliverySummary
        source="peer"
        title={title}
        status={[kind, `消息 ${item.messageId.slice(0, 8)}`]}
        preview={
          expanded
            ? undefined
            : delegationSnippet(item.body, deliveryCardPreviewLimit) ||
              deliverySnippet(item.body, deliveryCardPreviewLimit)
        }
        action={expanded ? "收起正文" : "展开正文"}
        onOpen={() => setExpanded(!expanded)}
        expanded={expanded}
        controls={detailsId}
      />
      <div id={detailsId} className="peer-message-body" hidden={!expanded}>
        {expanded && (
          <>
            <div className="delivery-summary-status">消息 {item.messageId}</div>
            <RichText text={item.body} cwd={cwd} />
          </>
        )}
      </div>
    </div>
  );
}
