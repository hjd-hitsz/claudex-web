import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import http from "node:http";
import { createProviderTransport } from "../src/backends/claude/provider-transport.mjs";

const chunkSize = 64 * 1024;
const requestStart = channel("http.server.request.start");

function post(proxy, chunks) {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/messages", proxy.url);
    const observe = ({ request }) => {
      if (request.socket.localPort !== Number(url.port)) return;
      let bytes = 0;
      request.on("data", (chunk) => {
        bytes += chunk.length;
        // Release the remaining bytes after the proxy reads the first chunk.
        if (bytes === chunkSize) outgoing.end(chunks[1]);
      });
    };
    if (chunks.length === 2) requestStart.subscribe(observe);
    const outgoing = http.request(
      url,
      {
        method: "POST",
        headers: {
          "x-api-key": proxy.token,
          "content-length": chunks.reduce(
            (bytes, chunk) => bytes + chunk.length,
            0,
          ),
        },
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        response.on("error", reject);
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    outgoing.on("close", () => {
      if (chunks.length === 2) requestStart.unsubscribe(observe);
    });
    outgoing.on("error", reject);
    if (chunks.length === 1) outgoing.end(chunks[0]);
    else outgoing.write(chunks[0]);
  });
}

for (const protocol of ["messages", "messages_compatible"]) {
  test(`${protocol} forwards Chinese UTF-8 split at a 64 KiB boundary`, async (t) => {
    const received = [];
    const upstream = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push(Buffer.concat(chunks));
      response.end("{}");
    });
    t.after(() => {
      upstream.close();
      upstream.closeAllConnections();
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

    const prefix = '{"system":[{"type":"text","text":"';
    const secretaryRole =
      "a".repeat(chunkSize - Buffer.byteLength(prefix + "你是") - 2) +
      "你是秘书。";
    // This body already has the system and thinking shape of both protocols.
    const source = Buffer.from(
      JSON.stringify({
        system: [{ type: "text", text: secretaryRole }],
        messages: [{ role: "user", content: "保留历史正文" }],
        thinking: { type: "disabled" },
      }),
    );
    assert.equal(source.indexOf(Buffer.from("秘")), chunkSize - 2);
    const proxy = await createProviderTransport(
      {
        protocol,
        apiKey: "fixture",
        baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      },
      undefined,
      secretaryRole,
    );
    t.after(() => proxy.close());

    assert.equal(await post(proxy, [source]), 200);
    assert.equal(
      await post(proxy, [
        source.subarray(0, chunkSize),
        source.subarray(chunkSize),
      ]),
      200,
    );
    assert.equal(received.length, 2);
    for (const body of received) {
      const difference = body.findIndex(
        (byte, index) => byte !== source[index],
      );
      assert(
        body.equals(source),
        `expected identical request bytes, first difference at byte ${difference}`,
      );
    }
  });
}
