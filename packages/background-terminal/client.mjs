import { request } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function privateDirectory(location) {
  const directory = await realpath(location);
  const stats = await stat(directory);
  if (
    !stats.isDirectory() ||
    stats.uid !== process.getuid() ||
    stats.mode & 0o077
  )
    throw new Error("任务状态目录须由当前用户持有，权限为 0700");
  return directory;
}
export function socketPath(directory) {
  const path = join(directory, "service.sock");
  if (Buffer.byteLength(path) > 107)
    throw new Error("任务服务 socket 路径超过 Linux 的 107 字节上限");
  return path;
}
export function mcpConfig(directory, upstream) {
  return {
    "mcp_servers.claudex_background": {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./cli.mjs", import.meta.url)),
        "mcp",
        directory,
      ],
      env: { CLAUDEX_BACKGROUND_UPSTREAM: new URL(upstream).href },
      enabled: true,
    },
  };
}
export async function taskRequest(directory, method, params = {}) {
  const path = socketPath(await privateDirectory(directory));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: path,
        method: "POST",
        signal: AbortSignal.timeout(45000),
      },
      async (response) => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          const data = JSON.parse(Buffer.concat(chunks));
          if (response.statusCode !== 200) throw new Error(data.error);
          resolve(data);
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ method, params }));
  });
}
