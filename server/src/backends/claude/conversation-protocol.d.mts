export type ConversationThread = {
  threadId: string;
  title: string;
  cwd: string;
};

export type ConversationEnvelope = {
  id: string;
  replyTo: string | null;
  from: ConversationThread & { runtimeId: string };
  to: ConversationThread & { runtimeId: string };
  body: string;
};

export type ConversationDelivery = {
  status: "delivered" | "queued" | "deferred" | "failed" | "unknown";
  evidence?: { messageUuid: string; source: string };
  reason?: string;
};

export type ConversationTool = (
  context: { threadId: string; turnId?: string },
  name: string,
  args: object,
) => Promise<unknown>;

export type ConversationInput = Pick<ConversationEnvelope, "id" | "from">;
