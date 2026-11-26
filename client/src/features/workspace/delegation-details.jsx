import React, { useState } from "react";
import { Square } from "lucide-react";
import { rpc, useStoreSelector } from "../../store.js";
import { isActiveSubAgent } from "../../domain/sub-agents.js";
import { IconButton } from "../../ui/primitives.jsx";
import { SubAgentConversation } from "./subagent-conversation.jsx";

export function DelegationDetails({ agent, parentId }) {
  const connected = useStoreSelector((state) => state.connected);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  async function stop() {
    setStopping(true);
    setError("");
    try {
      await rpc("lan/agy/delegation/cancel", {
        threadId: parentId,
        taskId: agent.delegation.taskId,
      });
    } catch (error) {
      setError(error.message);
    } finally {
      setStopping(false);
    }
  }
  return (
    <>
      <SubAgentConversation
        agent={{ ...agent, parentId }}
        actions={
          isActiveSubAgent(agent) && (
            <IconButton
              icon={Square}
              title={stopping ? "正在停止委派" : "停止委派"}
              disabled={!connected || stopping}
              onClick={stop}
            />
          )
        }
      />
      {error && (
        <p className="subagent-notice" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
