import { isCompacting } from "./compaction-state.mjs";
import type { Compaction } from "./compaction-state.mjs";

type BackendActivity = {
  installingBackends?: readonly unknown[];
  backends?: readonly { installation?: { installing?: boolean } }[];
  activeTurns?: object;
  backgroundTasks?: object;
  queuedInputs?: object;
  internalCommands?: readonly unknown[];
  questions?: readonly unknown[];
  compactions?: Record<string, Pick<Compaction, "status">>;
};

// 后端快照包含原生执行与网页占用；停止前仍须在执行方原子复核。
export function hasBackendWork(state: BackendActivity = {}) {
  return Boolean(
    state.installingBackends?.length ||
    state.backends?.some((backend) => backend.installation?.installing) ||
    Object.keys(state.activeTurns || {}).length ||
    Object.keys(state.backgroundTasks || {}).length ||
    Object.keys(state.queuedInputs || {}).length ||
    state.internalCommands?.length ||
    state.questions?.length ||
    Object.values(state.compactions || {}).some(isCompacting),
  );
}
