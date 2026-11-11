import { createHash, createDecipheriv, hkdfSync } from "node:crypto";
import { open, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";

export async function downloadArchive(
  component,
  directory,
  signal,
  progress,
  request = fetch,
) {
  const path = join(directory, "component.download");
  const response = await request(component.url, { signal });
  if (!response.ok) throw new Error(`模型下载失败 (${response.status})`);
  const file = await open(path, "w", 0o600);
  const hash = createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      received += chunk.length;
      if (received > component.size)
        throw new Error("模型下载大小超出目录记录");
      hash.update(chunk);
      await file.write(chunk);
      progress(received, component.size);
    }
  } finally {
    await file.close();
  }
  if (received !== component.size || hash.digest("hex") !== component.sha256)
    throw new Error("模型下载校验失败，请重试");
  const archive = await readFile(path);
  if (
    archive.toString("ascii", 0, 4) !== "Cr24" ||
    archive.readUInt32LE(4) !== 3
  )
    throw new Error("模型组件格式无效");
  const start = 12 + archive.readUInt32LE(8);
  return archive.subarray(start);
}

export async function extractComponent(zip, directory, kind) {
  const wanted =
    kind === "model"
      ? new Set([
          "encoder.onnx",
          "decoder.onnx",
          "encoder.onnx.data",
          "decoder.onnx.data",
          "tokenizer.json",
          "tokenizer_config.json",
          "config.json",
          "genai_config.json",
        ])
      : new Set(["libonnxruntime-genai.so"]);
  const entries = unzipSync(zip, {
    filter: (entry) =>
      kind === "model"
        ? entry.name.startsWith("en_zh_nmt/") &&
          wanted.has(entry.name.split("/").at(-1))
        : wanted.has(entry.name.split("/").at(-1)),
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hashes = {};
  for (const [path, bytes] of Object.entries(entries)) {
    const name = path.split("/").at(-1);
    let output = Buffer.from(bytes);
    if (kind === "model" && ["encoder.onnx", "decoder.onnx"].includes(name)) {
      const derived = Buffer.from(
        hkdfSync(
          "sha256",
          Buffer.from(`en_zh_nmt/${name}`),
          Buffer.alloc(0),
          Buffer.alloc(0),
          48,
        ),
      );
      const decipher = createDecipheriv(
        "aes-256-cbc",
        derived.subarray(16),
        derived.subarray(0, 16),
      );
      output = Buffer.concat([decipher.update(output), decipher.final()]);
    }
    await writeFile(join(directory, name), output, { mode: 0o600 });
    hashes[name] = createHash("sha256").update(output).digest("hex");
  }
  if (Object.keys(hashes).length !== wanted.size)
    throw new Error("下载组件缺少翻译模型文件");
  await rm(join(directory, "component.download"), { force: true });
  return hashes;
}
