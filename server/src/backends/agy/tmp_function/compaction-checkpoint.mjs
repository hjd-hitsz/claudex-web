// ACP 缺口：agy 1.5.18 的 session/compact 返回 -32601。session/prompt 的
// /compact 会生成原生检查点，手动和自动整理均未发出 compaction_update。
// 探测证据：隔离 Gemini 端点收到摘要请求，下一轮使用已持久化的
// CORTEX_STEP_TYPE_CHECKPOINT（23，DONE = 3）。本模块只读取检查点序号。
// 切换条件：ACP 发出同一会话的整理生命周期和整理后用量时，移除此读取。
// 登记见 docs/future_plan.md#缺口登记。
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function readAgyCheckpoint(
  nativeId,
  agent,
  directory = join(homedir(), ".gemini", "antigravity-cli"),
) {
  if (
    agent?.name !== "Antigravity ACP Server" ||
    agent.version !== "1.5.18" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nativeId)
  )
    return null;
  try {
    const database = new DatabaseSync(
      join(directory, "conversations", nativeId + ".db"),
      { readOnly: true },
    );
    try {
      return database
        .prepare(
          "SELECT COALESCE(MAX(idx), -1) AS checkpoint FROM steps WHERE step_type = 23 AND status = 3",
        )
        .get().checkpoint;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}
