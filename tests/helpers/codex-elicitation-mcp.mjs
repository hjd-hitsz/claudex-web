import { createInterface } from "node:readline";
const send = (packet) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n");
let original;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result, error } = JSON.parse(line);
  if (method === "initialize")
    send({
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "approval-audit", version: "1.0" },
      },
    });
  if (method === "tools/list")
    send({
      id,
      result: {
        tools: [
          {
            name: "confirm",
            description: "Return isolated test response",
            inputSchema: {
              type: "object",
              properties: { kind: { type: "string" } },
            },
          },
        ],
      },
    });
  if (method === "tools/call") {
    original = id;
    const kind = params.arguments.kind;
    const request =
      kind === "url"
        ? {
            mode: "url",
            message: "Audit URL",
            url: "https://example.invalid/approval",
            elicitationId: "fixture",
          }
        : {
            mode: "form",
            message: "Audit form",
            requestedSchema: {
              type: "object",
              properties:
                kind === "form" ? { confirm: { type: "boolean" } } : {},
            },
          };
    send({
      id: "fixture-elicitation",
      method: "elicitation/create",
      params: request,
    });
  }
  if (id === "fixture-elicitation")
    send({
      id: original,
      result: {
        content: [{ type: "text", text: JSON.stringify(result ?? error) }],
      },
    });
}
