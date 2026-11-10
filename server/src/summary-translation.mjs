export async function readTranslationInput(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("翻译文本过长，请缩短后重试");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createSummaryTranslationHandler(translate) {
  return async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end(JSON.stringify({ error: "翻译接口使用 POST 请求" }));
      return;
    }
    let texts;
    try {
      ({ texts } = await readTranslationInput(request));
      if (
        !Array.isArray(texts) ||
        !texts.length ||
        texts.length > 24 ||
        texts.some((text) => typeof text !== "string" || !text.trim())
      )
        throw new Error("翻译请求需包含 1 到 24 条有效文本");
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: error.message }));
      return;
    }
    try {
      const translations = await translate(texts);
      response.writeHead(200);
      response.end(JSON.stringify({ translations }));
    } catch (error) {
      response.writeHead(503);
      response.end(
        JSON.stringify({ error: error.message || "翻译失败，请重试" }),
      );
    }
  };
}
export function createTranslationSettingsHandler(service) {
  return async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    try {
      let result;
      if (request.method === "GET") result = await service.status();
      else if (request.method === "PUT") {
        const { enabled } = await readTranslationInput(request);
        if (typeof enabled !== "boolean") throw new Error("请提供翻译开关状态");
        result = await service.setEnabled(enabled);
      } else {
        response.writeHead(405, { Allow: "GET, PUT" });
        response.end(JSON.stringify({ error: "翻译设置使用 GET 或 PUT 请求" }));
        return;
      }
      response.writeHead(200);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: error.message }));
    }
  };
}
