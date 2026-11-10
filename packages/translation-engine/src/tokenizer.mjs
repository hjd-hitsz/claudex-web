import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export class EdgeTokenizer {
  constructor(directory, runtime) {
    this.pending = [];
    this.buffer = Buffer.alloc(0);
    this.error = null;
    this.child = spawn(
      fileURLToPath(new URL("../bin/tokenizer-linux-x64", import.meta.url)),
      [directory, join(runtime, "libonnxruntime-genai.so")],
      {
        env: { ...process.env, LD_LIBRARY_PATH: runtime },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let diagnostic = "";
    this.child.stderr.on("data", (bytes) => {
      diagnostic = (diagnostic + bytes).slice(-2000);
    });
    const failed = (error) => {
      this.error = error;
      for (const request of this.pending.splice(0)) request.reject(error);
    };
    this.child.on("error", failed);
    this.child.on("exit", (code) =>
      failed(new Error(diagnostic || `翻译分词进程已结束 (${code})`)),
    );
    this.child.stdin.on("error", failed);
    this.child.stdout.on("data", (bytes) => {
      this.buffer = Buffer.concat([this.buffer, bytes]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE();
        if (length > 4 * 1024 * 1024) {
          failed(new Error("分词响应过长"));
          this.child.kill();
          return;
        }
        if (this.buffer.length < length + 4) return;
        const result = this.buffer.subarray(4, length + 4);
        this.buffer = this.buffer.subarray(length + 4);
        this.pending.shift()?.resolve(result);
      }
    });
  }
  request(operation, input) {
    if (this.error) return Promise.reject(this.error);
    const header = Buffer.alloc(5);
    header.write(operation);
    header.writeUInt32LE(input.length, 1);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(Buffer.concat([header, input]));
    });
  }
  async encode(text) {
    const bytes = await this.request("E", Buffer.from(text));
    return Array.from({ length: bytes.length / 4 }, (_, index) =>
      bytes.readInt32LE(index * 4),
    );
  }
  async decode(tokens) {
    const bytes = Buffer.alloc(tokens.length * 4);
    tokens.forEach((token, index) => bytes.writeInt32LE(token, index * 4));
    return (await this.request("D", bytes)).toString("utf8");
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    const exited = once(this.child, "exit");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    this.child.stdin.end();
    await exited;
    clearTimeout(timer);
  }
}
