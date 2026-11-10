import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createSummaryTranslationHandler } from "../src/summary-translation.mjs";

async function translationServer(t, translate) {
  const server = http.createServer(createSummaryTranslationHandler(translate));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/api/translate`;
}

test("本站翻译接口接受匿名 POST，与 Codex 连接独立并保持顺序", async (t) => {
  const seen = [];
  const url = await translationServer(t, async (texts) => {
    seen.push(texts);
    return ["检查文件", "查看配置"];
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: ["Checking files", "Reviewing 配置"] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    translations: ["检查文件", "查看配置"],
  });
  assert.deepEqual(seen, [["Checking files", "Reviewing 配置"]]);
});

test("无效方法、批量参数和过长正文在本站拦截，完整读取 UTF-8 请求", async (t) => {
  const seen = [];
  const url = await translationServer(t, async (texts) => {
    seen.push(texts);
    return ["检查配置"];
  });
  const get = await fetch(url);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  for (const body of [
    "invalid json",
    "null",
    "{}",
    JSON.stringify({ texts: [] }),
    JSON.stringify({ texts: [""] }),
    JSON.stringify({ texts: [1] }),
    JSON.stringify({ texts: Array(25).fill("Checking files") }),
    JSON.stringify({ texts: ["x".repeat(256 * 1024)] }),
  ]) {
    const response = await fetch(url, { method: "POST", body });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal(seen.length, 0);
  const body = Buffer.from(JSON.stringify({ texts: ["Checking 配置"] }));
  const split = body.indexOf(Buffer.from("配")) + 1;
  const completed = new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST" }, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", reject);
    request.write(body.subarray(0, split));
    setImmediate(() => request.end(body.subarray(split)));
  });
  await completed;
  assert.deepEqual(seen, [["Checking 配置"]]);
});

test("本地引擎失败保留实际原因，重试后恢复译文", async (t) => {
  let attempts = 0;
  const url = await translationServer(t, async () => {
    if (++attempts === 1) throw new Error("模拟本地引擎失败");
    return ["检查文件"];
  });
  const options = {
    method: "POST",
    body: JSON.stringify({ texts: ["Checking files"] }),
  };
  const failed = await fetch(url, options);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    error: "模拟本地引擎失败",
  });
  const retried = await fetch(url, options);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { translations: ["检查文件"] });
});
