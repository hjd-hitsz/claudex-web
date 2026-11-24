import type { readConfig } from "../../config.mjs";
import type { RpcMessage } from "../../rpc-message.d.mts";
import type { hasBackendWork } from "../../../../shared/backend-activity.mjs";
import type { ExecutionBackend } from "./execution-types.d.mts";
import type { workerRevision } from "./worker-revision.mjs";

export type WorkerBackend = ExecutionBackend & {
  stateDir: string;
  dataDir: string;
};
export type WorkerConfig = Pick<
  ReturnType<typeof readConfig>,
  | "codexHome"
  | "claudeHome"
  | "configDir"
  | "backendsFile"
  | "defaultCwd"
  | "projectlessRoot"
>;
export type Revision = Awaited<ReturnType<typeof workerRevision>>;

type Configuration = {
  backend: WorkerBackend;
  config: WorkerConfig;
  runtimeEnv: Record<string, string | undefined>;
};

export type WorkerOptions = Configuration & {
  generation: number;
  revision?: Revision;
};
export type Replacement = WorkerOptions & { revision: Revision };

export type WorkerState = {
  method: "lan/state";
  params: NonNullable<Parameters<typeof hasBackendWork>[0]> & {
    ready: boolean;
    error?: string | null;
    pendingUpdate?: boolean;
    terminals?: object;
    undoneFiles?: unknown[];
  };
};

type WorkerOperations = {
  initialize: {
    input: { options: WorkerOptions };
    result: {
      pid: number;
      state: WorkerState;
      revision: Revision;
      busy: boolean;
      configuration?: Configuration;
      generation?: number;
    };
  };
  state: { input: object; result: WorkerState };
  shutdown: {
    input: { replacement?: Replacement };
    result: Record<string, never>;
  };
  rpc: { input: { message: RpcMessage }; result: RpcMessage | null };
};

export type Operation = keyof WorkerOperations;
export type WorkerInput<Kind extends Operation> = {
  kind: Kind;
} & WorkerOperations[NoInfer<Kind>]["input"];
export type WorkerCall<Kind extends Operation = Operation> = {
  [Key in Kind]: { kind: Key; id: string } & WorkerOperations[Key]["input"];
}[Kind];
export type WorkerResult<Kind extends Operation> =
  WorkerOperations[Kind]["result"];
export type WorkerRequest = WorkerCall | { kind: "release" };
export type WorkerPacket =
  | { kind: "state"; message: WorkerState }
  | { kind: "event"; message: RpcMessage }
  | {
      kind: "response";
      id?: string;
      result?: unknown;
      error?: string;
      errorCode?: string;
    }
  | { kind: "error"; error: string };
