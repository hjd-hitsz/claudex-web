import { workspaceMethods } from "../../../shared/product-contract.mjs";
import { fileRequest } from "./files.mjs";
import { executeCommand } from "./commands.mjs";
import { createTerminals } from "./terminals.mjs";
import { createFileSearch } from "./file-search.mjs";

export function createWorkspace({ broadcast, configDir }) {
  const terminals = createTerminals(broadcast);
  const files = createFileSearch();
  const methods = new Set(workspaceMethods);
  return {
    handles(method, backend, workspaceOwner) {
      if (backend && method === "fuzzyFileSearch")
        return (
          backend.type === "claude" ||
          ["127.0.0.1", "localhost", "[::1]"].includes(
            new URL(backend.url).hostname,
          )
        );
      return methods.has(method) && (!backend || workspaceOwner === "bridge");
    },
    request(method, params) {
      if (method === "fuzzyFileSearch") return files.search(params);
      if (method.startsWith("fs/"))
        return fileRequest(method, params, configDir);
      if (method === "command/exec" && !params.tty)
        return executeCommand(params);
      if (
        method.startsWith("command/exec") ||
        method.startsWith("lan/terminal/")
      )
        return terminals.request(method, params);
      throw new Error(`未知工作区操作：${method}`);
    },
    snapshot: terminals.snapshot,
    close() {
      files.close();
      terminals.close();
    },
  };
}
