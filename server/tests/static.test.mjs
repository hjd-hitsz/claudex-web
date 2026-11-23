import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticHandler, isStaticAsset } from "../src/http/static.mjs";

test("同名网页资源按响应编码重新校验，字体按内容哈希缓存", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claudex-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Object.entries({
      "index.html": "<html></html>",
      "app.js": "const value = 1;",
      "p2p-sw.js": "register();",
      "font-H4sh_T3st.woff2": "fixture font",
    }).map(([name, body]) => writeFile(join(root, name), body)),
  );
  const serve = createStaticHandler(root);
  const server = createServer((req, res) => serve(req, res, req.url));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  const request = (path, options) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, options);

  for (const path of ["/", "/p2p-sw.js"]) {
    const response = await request(path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
    await response.body.cancel();
  }
  const gzip = await request("/app.js", {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(gzip.headers.get("cache-control"), "public, no-cache");
  assert.equal(gzip.headers.get("content-encoding"), "gzip");
  assert.equal(await gzip.text(), "const value = 1;");
  const etag = gzip.headers.get("etag");
  assert.ok(etag);
  const cached = await request("/app.js", {
    headers: { "Accept-Encoding": "gzip", "If-None-Match": "W/" + etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get("vary"), "Accept-Encoding");
  assert.equal(await cached.text(), "");
  const head = await request("/app.js", {
    method: "HEAD",
    headers: { "Accept-Encoding": "identity", "If-None-Match": etag },
  });
  assert.equal(head.status, 200);
  assert.notEqual(head.headers.get("etag"), etag);
  await writeFile(join(root, "app.js"), "const value = 200;");
  const updated = await request("/app.js", {
    headers: { "Accept-Encoding": "gzip", "If-None-Match": etag },
  });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.headers.get("etag"), etag);
  assert.equal(await updated.text(), "const value = 200;");
  const path = "/font-H4sh_T3st.woff2";
  assert.ok(isStaticAsset(path));
  assert.equal(isStaticAsset("/unhashed.woff2"), false);
  const font = await request(path);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.match(font.headers.get("cache-control"), /immutable/);
  assert.equal(await font.text(), "fixture font");
});
