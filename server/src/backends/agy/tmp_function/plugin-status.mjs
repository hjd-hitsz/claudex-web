// ACP 缺口：缺少已安装插件和 MCP 状态查询接口。
// 探测证据：agy 1.5.18 的 plugin/installed、mcpServerStatus/list 均返回
// -32601 Method not found。同版本的 plugin list --json 和 mcp list 可只读列举配置，
// 秘书会话的注入连接来自对应令牌的 MCP tools/list 和 ready 回执。
// 切换条件：ACP 能返回实际安装状态、配置状态及会话级 MCP 连接和工具，
// 并通过 docs/future_plan.md「插件与 MCP 状态」的切换检查。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkProxyEnvironment } from "../../network-proxy.mjs";
import { agyPage } from "../session-store.mjs";

const exec = promisify(execFile);

export function parseAgyPlugins(stdout) {
  const plugins = JSON.parse(stdout);
  if (!Array.isArray(plugins)) throw new Error("无效的 agy 插件目录");
  return plugins.map(({ name, enabled }) => {
    if (typeof name !== "string" || !name || typeof enabled !== "boolean")
      throw new Error("无效的 agy 插件记录");
    return { name, enabled };
  });
}

export function parseAgyMcp(stdout) {
  const [header, ...rows] = stdout.trim().split(/\r?\n/);
  if (header === "No MCP servers configured." && !rows.length) return [];
  const layout = /^NAME( +)TYPE( +)STATUS( +)COMMAND\/URL$/.exec(header);
  if (!layout) throw new Error("无效的 agy MCP 目录");
  const typeStart = 4 + layout[1].length;
  const statusStart = typeStart + 4 + layout[2].length;
  const commandStart = statusStart + 6 + layout[3].length;
  return rows.map((row) => {
    const columns = Array.from(row);
    const field = (start, end) => columns.slice(start, end).join("").trim();
    const name = field(0, typeStart);
    const type = field(typeStart, statusStart);
    const status = field(statusStart, commandStart);
    if (
      !name ||
      !["http", "stdio"].includes(type) ||
      !["enabled", "disabled"].includes(status)
    )
      throw new Error("无效的 agy MCP 配置");
    return {
      name,
      status: status === "enabled" ? "configured" : "disabled",
    };
  });
}

export function agyPluginMethods({
  getBackend,
  defaultCwd,
  entries,
  execCli = exec,
}) {
  async function catalog(args, cwd, parse) {
    const { executable, proxy } = getBackend();
    try {
      const { stdout } = await execCli(executable, args, {
        cwd: cwd || defaultCwd,
        env: { ...process.env, ...networkProxyEnvironment(proxy) },
        encoding: "utf8",
        timeout: 5000,
      });
      return { rows: parse(stdout), unavailable: false };
    } catch {
      return { rows: [], unavailable: true };
    }
  }
  return new Map([
    [
      "plugin/installed",
      async ({ cwd }) => {
        const { rows: plugins, unavailable } = await catalog(
          ["plugin", "list", "--json"],
          cwd,
          parseAgyPlugins,
        );
        return {
          marketplaces: plugins.length ? [{ plugins }] : [],
          unavailable,
        };
      },
    ],
    [
      "mcpServerStatus/list",
      async (params) => {
        const { rows, unavailable } = await catalog(
          ["mcp", "list"],
          params.cwd,
          parseAgyMcp,
        );
        const entry = entries.get(params.threadId);
        if (entry?.toolsReady && entry.mcpTools) {
          const name = "claudex_delegation";
          const server = {
            name,
            status: "connected",
            tools: Object.fromEntries(entry.mcpTools.map((tool) => [tool, {}])),
          };
          return {
            ...agyPage(
              [...rows.filter((row) => row.name !== name), server],
              params,
              false,
            ),
            unavailable,
          };
        }
        return { ...agyPage(rows, params, false), unavailable };
      },
    ],
  ]);
}
