import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createCipheriv, hkdfSync } from "node:crypto";
import { zipSync } from "fflate";
import { ModelStore, defaultModelDirectory } from "../src/model-store.mjs";

function archive(files) {
  const zip = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, value]) => [name, Buffer.from(value)]),
    ),
  );
  const header = Buffer.alloc(12);
  header.write("Cr24");
  header.writeUInt32LE(3, 4);
  const body = Buffer.concat([header, zip]);
  return {
    body,
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    version: "2026.10.22.1",
    url: "https://fixture.invalid/component",
  };
}
function fixtures() {
  const files = {};
  for (const name of ["encoder.onnx", "decoder.onnx"]) {
    const derived = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(`en_zh_nmt/${name}`),
        Buffer.alloc(0),
        Buffer.alloc(0),
        48,
      ),
    );
    const cipher = createCipheriv(
      "aes-256-cbc",
      derived.subarray(16),
      derived.subarray(0, 16),
    );
    files[`en_zh_nmt/${name}`] = Buffer.concat([
      cipher.update(Buffer.from(`fixture ${name}`)),
      cipher.final(),
    ]);
  }
  for (const name of [
    "encoder.onnx.data",
    "decoder.onnx.data",
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
    "genai_config.json",
  ])
    files[`en_zh_nmt/${name}`] = "fixture";
  files["zh_en_nmt/unneeded.data"] = "excluded direction";
  return {
    model: archive(files),
    tokenizer: archive({ "libonnxruntime-genai.so": "fixture tokenizer" }),
  };
}
async function fixtureRuntime(directory) {
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("fixture CPU runtime");
  await writeFile(join(directory, "libonnxruntime.so"), bytes);
  return {
    "libonnxruntime.so": createHash("sha256").update(bytes).digest("hex"),
  };
}
test("默认模型目录位于当前用户的数据目录", () => {
  assert.equal(
    defaultModelDirectory(),
    join(homedir(), ".local", "share", "claudex-translation", "models"),
  );
});
test("并发安装只下载一次，解包校验后原子启用，离线复用已安装模型", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "translation-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const components = fixtures();
  let catalogs = 0;
  let downloads = 0;
  const options = {
    installRuntime: fixtureRuntime,
    catalog: async () => {
      catalogs++;
      return components;
    },
    request: async (url) => {
      downloads++;
      return new Response(
        url.endsWith("tokenizer")
          ? components.tokenizer.body
          : components.model.body,
      );
    },
  };
  components.tokenizer.url += "/tokenizer";
  const first = new ModelStore(directory, options);
  assert.equal(await first.installed(), null);
  assert.equal(catalogs, 0);
  const [installed, concurrent] = await Promise.all([
    first.prepare(new AbortController().signal),
    new ModelStore(directory, options).prepare(new AbortController().signal),
  ]);
  assert.equal(installed.directory, concurrent.directory);
  assert.equal(catalogs, 1);
  assert.equal(downloads, 2);
  assert.equal(
    await readFile(join(installed.directory, "model", "encoder.onnx"), "utf8"),
    "fixture encoder.onnx",
  );
  assert.ok(
    !(await readdir(join(installed.directory, "model"))).includes(
      "unneeded.data",
    ),
  );
  await first.verify(installed);
  await first.prepare(new AbortController().signal);
  assert.equal(downloads, 2);
  await writeFile(
    join(installed.directory, "model", "encoder.onnx"),
    "corrupt",
  );
  await assert.rejects(first.verify(installed), /校验失败/);
  const repaired = await first.prepare(new AbortController().signal);
  await first.verify(repaired);
  assert.equal(downloads, 4);
  await rm(join(repaired.directory, "model", "decoder.onnx"));
  await first.prepare(new AbortController().signal);
  assert.equal(downloads, 6);
});
test("下载损坏与取消均清理临时目录，失败后可以重新安装", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "translation-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const components = fixtures();
  let damaged = true;
  const store = new ModelStore(directory, {
    installRuntime: fixtureRuntime,
    catalog: async () => components,
    request: async (url) =>
      new Response(
        damaged
          ? Buffer.alloc(components.model.size)
          : url.endsWith("tokenizer")
            ? components.tokenizer.body
            : components.model.body,
      ),
  });
  components.tokenizer.url += "/tokenizer";
  await assert.rejects(store.prepare(new AbortController().signal), /校验失败/);
  assert.equal(await store.installed(), null);
  assert.deepEqual(await readdir(store.directory), []);
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await assert.rejects(store.prepare(abort.signal), /cancelled/);
  damaged = false;
  assert.ok(await store.prepare(new AbortController().signal));
});
