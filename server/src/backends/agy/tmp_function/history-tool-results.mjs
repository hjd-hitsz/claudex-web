// ACP 缺口：agy 1.5.18 的 tool_call_update 不携带工具结果正文，
// 分叉与编辑重放历史时无法还原工具输出；同一版本的 session/fork、
// session/rewind、session/revert 等原生操作也返回 -32601 Method not found。
// 探测证据：read_file 完成时 ACP tool_call_update 未携带结果正文，原生
// steps 表的工具记录保留同一 toolCallId 和提交给模型的输出。
// 切换条件：原生分叉和回退保留工具上下文，或 ACP 事件提供完整工具结果。
// 登记见 docs/future_plan.md#缺口登记。
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativePath } from "./native-history-index.mjs";
import { nativeHistoryRoot } from "./native-history-transaction.mjs";

const nativeIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });

// agy 1.5.18 的 steps.step_payload 使用 Protobuf。只读取有界字段，
// 工具参数、权限及其余原生会话内容继续保存在原库。
function bytesAt(message, field) {
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 70 && offset < message.length; shift += 7) {
      const byte = message[offset++];
      if (shift < 53) value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("无效的 agy 原生字段");
  };
  while (offset < message.length) {
    const tag = varint();
    switch (tag % 8) {
      case 0:
        varint();
        break;
      case 1:
        offset += 8;
        break;
      case 2: {
        const size = varint();
        const start = offset;
        offset += size;
        if (offset > message.length) throw new Error("无效的 agy 原生字段长度");
        if (Math.floor(tag / 8) === field)
          return message.subarray(start, offset);
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        throw new Error("未知的 agy 原生字段格式");
    }
  }
  return new Uint8Array();
}

export function findAgyToolResults(
  callIds,
  nativeIds,
  agentInfo,
  { home = homedir(), limit = Infinity } = {},
) {
  const results = new Map();
  if (
    agentInfo?.name !== "Antigravity ACP Server" ||
    agentInfo.version !== "1.5.18"
  )
    return results;
  const missing = new Set(callIds);
  const directory = join(home, ".gemini", "antigravity-cli");
  for (const id of new Set(nativeIds)) {
    if (!missing.size || !nativeIdPattern.test(id)) continue;
    let db;
    try {
      const path =
        nativePath(directory, "conversations/" + id + ".db") ??
        nativePath(directory, nativeHistoryRoot + "/archived/" + id + ".db");
      if (!path) continue;
      db = new DatabaseSync(path, { readOnly: true });
      // step_type 132 stores generic tool results. Metadata field 4 holds the
      // native call, and the tool response text is at payload fields 140/2/1.
      const rows = db
        .prepare(
          "SELECT metadata, step_payload FROM steps WHERE step_type = 132 AND status = 3 AND step_format = 0 ORDER BY idx DESC",
        )
        .iterate();
      for (const { metadata, step_payload } of rows) {
        if (!metadata || !step_payload) continue;
        const call = bytesAt(metadata, 4);
        const callId = utf8.decode(bytesAt(call, 1));
        if (!missing.has(callId)) continue;
        const tool = utf8.decode(bytesAt(call, 2));
        const text = utf8.decode(
          bytesAt(bytesAt(bytesAt(step_payload, 140), 2), 1),
        );
        if (text) {
          results.set(callId, {
            nativeId: id,
            tool,
            text:
              text.length > limit
                ? text.slice(0, limit).toWellFormed() + "…"
                : text,
          });
          missing.delete(callId);
        }
        if (!missing.size) break;
      }
    } catch (error) {
      // A missing or newer native layout leaves the observed ACP call intact.
      if (error.code !== "SQLITE_BUSY")
        console.warn("读取 agy 历史工具结果失败：" + error.message);
    } finally {
      db?.close();
    }
  }
  return results;
}

export function restoreAgyToolResults(turns, nativeIds, agentInfo, home) {
  const items = turns.flatMap(({ items }) =>
    items.filter(
      (item) =>
        item.type === "mcpToolCall" &&
        item.status === "completed" &&
        !item.result,
    ),
  );
  const results = findAgyToolResults(
    items.map(({ id }) => id),
    nativeIds,
    agentInfo,
    { home, limit: 4000 },
  );
  for (const item of items) {
    const result = results.get(item.id);
    if (!result) continue;
    const { nativeId, tool, text } = result;
    item.result = {
      content: [{ type: "text", text }],
    };
    item.nativeTool = tool;
    item.resultArchive = nativeId;
  }
}
