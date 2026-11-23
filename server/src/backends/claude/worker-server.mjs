import { runWorker } from "../worker/worker-server.mjs";
import { createClaudeAdapter } from "./adapter.mjs";
import { claudeWorkerState } from "./worker-state.mjs";
await runWorker({
  backendId: "claude",
  createAdapter: createClaudeAdapter,
  entry: import.meta.url,
  readState: claudeWorkerState,
});
