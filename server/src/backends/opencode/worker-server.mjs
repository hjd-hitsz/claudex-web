import { runWorker } from "../worker/worker-server.mjs";
import { createOpenCodeAdapter } from "./adapter.mjs";
await runWorker({
  backendId: "opencode",
  createAdapter: createOpenCodeAdapter,
  entry: import.meta.url,
});
