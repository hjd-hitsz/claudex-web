export { providerRuntimeEnvironment } from "./provider-environment.mjs";
import { messagesRequest } from "./messages-request.mjs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nativeProviderHeaders } from "./native-provider.mjs";

export async function createProviderTransport(
  provider,
  subagent,
  secretaryRole,
) {
  const token = randomUUID();
  const targets = new Map();
  let subagentModel;
  let targetKey;
  function setSubagent(target) {
    const key = JSON.stringify(target);
    if (key === targetKey) return;
    targetKey = key;
    subagentModel = target ? `claudex-subagent-${randomUUID()}` : null;
    if (target) targets.set(subagentModel, target);
  }
  setSubagent(subagent);
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
        const target = targets.get(input.model);
        if (target) {
          selected = target.provider;
          input = { ...input, model: target.model };
          if (target.effort && !request.url.includes("/count_tokens"))
            input.output_config = {
              ...input.output_config,
              effort: target.effort,
            };
        }
        if (selected)
          input = messagesRequest(input, {
            standard: (selected.protocol || "messages") === "messages",
            secretaryRole: target ? undefined : secretaryRole,
          });
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
          if (selected.authentication !== "bearer")
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
    setSubagent,
    get subagentModel() {
      return subagentModel;
    },
    get modelCapabilities() {
      return Object.fromEntries(
        [...targets].map(([model, target]) => [
          model,
          target.provider.modelCapabilities?.[target.model] || {},
        ]),
      );
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
