import { evidencePage } from "../delegation/evidence-page.mjs";
import { findAgyToolResults } from "./tmp_function/history-tool-results.mjs";

export const archivedToolOutput = {
  name: "read_archived_tool_output",
  title: "读取已存档的 Antigravity 工具输出",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["callId"],
    properties: {
      callId: { type: "string", minLength: 1, maxLength: 256 },
      offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    },
  },
};

export async function readArchivedToolOutput(
  store,
  threadId,
  input,
  agentInfo,
) {
  const { callId, offset, ...extra } = input ?? {};
  if (
    typeof callId !== "string" ||
    !callId.trim() ||
    callId.length > 256 ||
    Object.keys(extra).length ||
    (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
  )
    throw new Error("请填写已存档的工具调用 ID");
  const data = await store.read();
  const session = store.session(data, threadId);
  const item = session.turns
    .flatMap(({ items }) => items)
    .find((item) => item.type === "mcpToolCall" && item.id === callId);
  if (!item || !["completed", "failed"].includes(item.status))
    throw new Error("当前会话找不到该已存档工具调用");

  const nativeIds = [item.resultArchive];
  const lineage = new Set();
  for (let current = session; current && !lineage.has(current.id);) {
    lineage.add(current.id);
    nativeIds.push(current.nativeId, current.previousNativeId);
    current = data.sessions[current.source?.threadId];
  }
  const native = findAgyToolResults([callId], nativeIds, agentInfo).get(callId);
  const output = native?.text ?? item.result ?? item.error;
  if (output == null) throw new Error("该工具没有可读取的输出");
  return evidencePage(
    {
      callId,
      tool: native?.tool || item.nativeTool || item.tool,
      source: native ? "native" : "saved",
      output,
    },
    offset,
  );
}
