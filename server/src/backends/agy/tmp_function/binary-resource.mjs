// ACP 缺口：agy 1.5.18 的 embeddedContext 接受文本资源，模型请求会跳过 blob 资源。
// 探测证据：session/prompt 的 PDF、二进制 resource.blob 均返回 end_turn，
// 隔离 Gemini 请求只包含同轮 resource.text 的内容。
// 切换条件：隔离模型请求保留 ACP resource.blob 的字节和原始媒体类型。
import { readPromptSections, renderPrompt } from "../../../prompts.mjs";

const binary = readPromptSections("references/message-context.md")(
  "binaryResource",
);

export function embedBinaryResource(mimeType, bytes) {
  return renderPrompt(binary, { mimeType, base64: bytes.toString("base64") });
}
