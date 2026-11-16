export { providerRuntimeEnvironment } from "./provider-environment.mjs";
import { messagesRequest } from "./messages-request.mjs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nativeProviderHeaders } from "./native-provider.mjs";

export async function createProviderTransport(provider, subagent) {
  const token = randomUUID();
  const subagentModel = subagent ? `claudex-subagent-${randomUUID()}` : null;
  const nativeBaseUrl =
    process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const server = http.createServer(async (request, response) => {
    if (
      request.headers["x-claudex-proxy-token"] !== token &&
      request.headers["x-api-key"] !== token &&
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 64 * 1024 * 1024) throw new Error("请求过大");
      }
      let selected = provider;
      if (body) {
        let input = JSON.parse(body);
        if (subagent && input.model === subagentModel) {
          selected = subagent.provider;
          input = { ...input, model: subagent.model };
          if (subagent.effort && !request.url.includes("/count_tokens"))
            input.output_config = {
              ...input.output_config,
              effort: subagent.effort,
            };
        }
        if (selected && (selected.protocol || "messages") === "messages")
          input = messagesRequest(input);
        body = JSON.stringify(input);
      }
      const headers = { ...request.headers };
      if (selected) {
        delete headers["x-api-key"];
        delete headers.authorization;
        delete headers["anthropic-organization-id"];
        if (selected.native)
          Object.assign(headers, await nativeProviderHeaders(selected));
        else {
          headers["x-api-key"] = selected.apiKey;
          headers.authorization = `Bearer ${selected.apiKey}`;
        }
      }
      delete headers["x-claudex-proxy-token"];
      delete headers.host;
      delete headers["content-length"];
      delete headers.connection;
      const abort = new AbortController();
      response.on("close", () => {
        if (!response.writableEnded) abort.abort();
      });
      const target = new URL(
        (selected?.baseUrl || nativeBaseUrl) + request.url,
      );
      const options = {
        method: request.method,
        headers,
        ...(body && { body }),
        signal: abort.signal,
      };
      const upstream = await fetch(target, options);
      response.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
      });
      if (upstream.body)
        await pipeline(Readable.fromWeb(upstream.body), response);
      else response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(502);
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    subagentModel,
    modelCapabilities: subagent
      ? {
          [subagentModel]:
            subagent.provider.modelCapabilities?.[subagent.model] || {},
        }
      : {},
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
