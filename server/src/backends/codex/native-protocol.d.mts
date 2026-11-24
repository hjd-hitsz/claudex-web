import type {
  RequestId,
  RpcMessage as Envelope,
} from "../../rpc-message.d.mts";
import type { CompactionTurn } from "../../../../shared/compaction-state.mjs";
import type { FileChangeItem } from "../../file-undo.mjs";
export type { RequestId, RpcError } from "../../rpc-message.d.mts";

export type NativeParams = Record<string, unknown> & {
  threadId?: string;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
  input?: readonly { type: string; text?: string }[];
  model?: string;
  processId?: string;
  excludeTurns?: boolean;
};

export type RpcMessage = Envelope<NativeParams>;

export type NativeEventParams = NativeParams & {
  turnId?: string;
  turn?: CompactionTurn;
  willRetry?: boolean;
  error?: { message?: string };
  item?: { id: string; type: string; text?: string } & Record<string, unknown>;
  itemId?: string;
  delta?: string;
  goal?: { status?: string };
  status?: { type: string };
  requestId?: RequestId;
  deltaBase64?: string;
};

export type NativeEvent = Envelope<NativeEventParams> & { method: string };

export type ResumeParams = NativeParams & {
  threadId: string;
  excludeTurns?: boolean;
};

// 订阅调度只消费原生响应的标识与加载状态，其余字段仍随原生消息传递。
type ManagedMethods = {
  "thread/resume": {
    params: ResumeParams;
    result: {
      thread: {
        id: string;
        status?: { type: "notLoaded" | "idle" | "systemError" | "active" };
      };
    };
  };
  "thread/unsubscribe": {
    params: NativeParams & { threadId: string };
    result: { status: "notLoaded" | "notSubscribed" | "unsubscribed" };
  };
  "thread/read": {
    params: NativeParams & { threadId: string; includeTurns?: boolean };
    result: {
      thread: {
        id: string;
        cwd: string;
        status?: { type: string };
        turns: (CompactionTurn & { items: FileChangeItem[] })[];
      };
    };
  };
  "thread/turns/list": {
    params: NativeParams & {
      threadId: string;
      cursor?: string | null;
      limit?: number | null;
      itemsView?: "notLoaded" | "summary" | "full" | null;
    };
    result: { data: CompactionTurn[]; nextCursor: string | null };
  };
};

export type CallParams<Method extends string> =
  Method extends keyof ManagedMethods
    ? ManagedMethods[Method]["params"]
    : NativeParams;

export type CallResult<Method extends string> =
  Method extends keyof ManagedMethods
    ? ManagedMethods[Method]["result"]
    : unknown;
