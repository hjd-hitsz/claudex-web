import { defineConfig, loadEnv } from "vite";
import { writeFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersion } from "../server/src/version.mjs";
import { readConfig } from "../server/src/config.mjs";
import { readTls, localTlsClient } from "../server/src/tls.mjs";

const font = /\.(?:woff2?|ttf)$/i;

export default defineConfig(async ({ mode, command }) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const env = loadEnv(mode, root, "");
  const target = `https://127.0.0.1:${env.PORT || 8766}`;
  const tls = command === "serve" ? await readTls(readConfig(env)) : null;
  const agent = tls ? new https.Agent(localTlsClient(tls.cert)) : undefined;
  const buildInfo = { ...readVersion(root), builtAt: new Date().toISOString() };
  if (command === "build")
    writeFileSync(
      join(root, "build-info.json"),
      JSON.stringify(buildInfo, null, 2) + "\n",
    );
  return {
    define: { __CLAUDEX_WEB_BUILD__: JSON.stringify(buildInfo) },
    server: {
      https: tls,
      proxy: {
        "/rpc": {
          target,
          ws: true,
          agent,
        },
        "/healthz": {
          target,
          agent,
        },
        "/api": {
          target,
          agent,
        },
      },
    },
    build: {
      cssCodeSplit: false,
      assetsInlineLimit: (path) => !font.test(path),
      rollupOptions: {
        output: {
          entryFileNames: "app.js",
          chunkFileNames: "[name].js",
          assetFileNames(asset) {
            if (asset.names.some((name) => name.endsWith(".css")))
              return "style.css";
            if (asset.names.some((name) => font.test(name)))
              return "font-[hash][extname]";
            return "[name][extname]";
          },
        },
      },
    },
  };
});
