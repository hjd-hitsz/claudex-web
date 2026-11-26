import { createHash } from "node:crypto";

export function runtimeIdentity(backend) {
  return createHash("sha256")
    .update(
      JSON.stringify([backend.id, backend.type, backend.url, backend.dataDir]),
    )
    .digest("hex")
    .slice(0, 32);
}
