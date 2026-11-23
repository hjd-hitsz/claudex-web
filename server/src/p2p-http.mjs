import { Readable, Writable } from "node:stream";
import {
  P2P_STREAM_CHUNK_BYTES,
  P2P_STREAM_CREDIT_WINDOW,
} from "../../shared/p2p-wire.mjs";

class PeerResponse extends Writable {
  constructor(send, id, method) {
    super();
    this.send = send;
    this.id = id;
    this.method = method;
    this.headers = {};
    this.headersSent = false;
    this.statusCode = 200;
    this.credit = 0;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = String(value);
  }

  writeHead(status, headers = {}) {
    if (this.headersSent || this.destroyed) return this;
    for (const [name, value] of Object.entries(headers))
      this.setHeader(name, value);
    this.statusCode = status;
    this.headersSent = true;
    this.headerSent = this.send({
      type: "response",
      id: this.id,
      status,
      headers: this.headers,
      creditWindow: P2P_STREAM_CREDIT_WINDOW,
    });
    this.headerSent.catch(() => this.destroy());
    return this;
  }

  pull() {
    if (this.destroyed || this.credit >= P2P_STREAM_CREDIT_WINDOW) return;
    this.credit++;
    this.resumeWrite?.();
  }

  async _write(chunk, encoding, callback) {
    try {
      this.writeHead(this.statusCode);
      await this.headerSent;
      if (this.method !== "HEAD") {
        for (
          let offset = 0;
          offset < chunk.length;
          offset += P2P_STREAM_CHUNK_BYTES
        ) {
          if (!this.credit && !this.destroyed)
            await new Promise((resolve) => {
              this.resumeWrite = resolve;
            });
          this.resumeWrite = null;
          if (this.destroyed) break;
          this.credit--;
          await this.send(
            { type: "data", id: this.id },
            chunk.subarray(offset, offset + P2P_STREAM_CHUNK_BYTES),
          );
        }
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    this.writeHead(this.statusCode);
    this.send({ type: "end", id: this.id }).then(() => callback(), callback);
  }

  _destroy(error, callback) {
    this.resumeWrite?.();
    callback(error);
  }
}

export function createPeerHttp(handle, wire) {
  const active = new Map();

  return {
    receive(message, bytes) {
      const { type, id, method, url, headers } = message;
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("无效请求编号");
      const running = active.get(id);
      if (type === "pull") {
        running?.pull();
        return;
      }
      if (type === "cancel") {
        running?.destroy();
        return;
      }
      if (type !== "request" || running) throw new Error("无效直连请求");
      const fail = (message) => {
        wire.send({ type: "error", id, message }).catch(() => {});
      };
      if (
        active.size >= 32 ||
        !["GET", "HEAD", "POST", "PUT"].includes(method) ||
        typeof url !== "string" ||
        !url.startsWith("/api/") ||
        url.length > 16384
      ) {
        fail("直连 HTTP 请求无效或过多");
        return;
      }
      const parsed = new URL(url, "https://localhost");
      if (parsed.origin !== "https://localhost") {
        fail("直连 HTTP 地址无效");
        return;
      }
      const request = Readable.from(bytes.length ? [Buffer.from(bytes)] : []);
      request.method = method;
      request.url = parsed.pathname + parsed.search;
      request.headers = {};
      for (const name of ["range", "content-type"])
        if (typeof headers?.[name] === "string" && headers[name].length <= 1024)
          request.headers[name] = headers[name];
      const response = new PeerResponse(wire.send, id, method);
      active.set(id, response);
      response.on("close", () => {
        active.delete(id);
        request.destroy();
      });
      response.on("error", () => fail("直连响应传输中断"));
      Promise.resolve()
        .then(() => {
          if (response.destroyed) return;
          return (
            handle(request, response, parsed.pathname) ||
            response.writeHead(404).end()
          );
        })
        .catch(() => {
          if (response.destroyed) return;
          if (response.headersSent) response.destroy(new Error("请求处理失败"));
          else response.writeHead(500).end();
        });
    },
    close() {
      for (const response of active.values()) response.destroy();
      active.clear();
    },
  };
}
