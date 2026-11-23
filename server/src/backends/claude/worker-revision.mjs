import { fileURLToPath } from "node:url";
import { workerRevision as revision } from "../worker/worker-revision.mjs";
const entry = fileURLToPath(new URL("./worker-server.mjs", import.meta.url));
export const workerRevision = () => revision(entry);
