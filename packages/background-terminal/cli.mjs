#!/usr/bin/env node
import { resolve } from "node:path";
const [mode, state, upstream] = process.argv.slice(2);
if (mode === "serve" && state && upstream) {
  const { serve } = await import("./service.mjs");
  await serve(resolve(state), upstream);
} else if (mode === "mcp" && state && !upstream) {
  await import("./background-mcp.mjs");
} else {
  console.error(
    "Usage: codex-background-terminal serve STATE_DIR ws://127.0.0.1:PORT | mcp STATE_DIR",
  );
  process.exitCode = 2;
}
