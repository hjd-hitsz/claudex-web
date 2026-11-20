import { MAX_RPC_MESSAGE_BYTES } from "./rpc-limits.mjs";

const frameSize = 16 * 1024;
const maxJsonBytes = 64 * 1024;
export const MAX_P2P_BODY_BYTES = 512 * 1024;
export const P2P_STREAM_CHUNK_BYTES = 64 * 1024;
const bufferLimit = 256 * 1024;
const maxQueueBytes = 2 * MAX_RPC_MESSAGE_BYTES;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function createP2pWire({ sendFrame, bufferedAmount, receive, close }) {
  let closed = false;
  let pending = Promise.resolve();
  let queuedBytes = 0;
  let incoming;
  let deadline;

  function shutdown() {
    closed = true;
    incoming = null;
    clearTimeout(deadline);
  }

  function fail(error) {
    if (closed) return;
    shutdown();
    close(error);
  }

  function send(message, binary = new Uint8Array()) {
    if (closed) return Promise.reject(new Error("直连已断开"));
    const rpc = message.type === "rpc";
    if (rpc) binary = encoder.encode(message.text);
    const json = encoder.encode(
      JSON.stringify(rpc ? { type: "rpc" } : message),
    );
    const size = json.length + binary.byteLength + 8;
    if (
      json.length > maxJsonBytes ||
      binary.byteLength > (rpc ? MAX_RPC_MESSAGE_BYTES : MAX_P2P_BODY_BYTES) ||
      queuedBytes + size > maxQueueBytes
    ) {
      const error = new Error("直连消息超过传输限制");
      fail(error);
      return Promise.reject(error);
    }
    queuedBytes += size;
    const operation = pending.then(async () => {
      const prefix = new Uint8Array(8 + json.length);
      const header = new DataView(prefix.buffer);
      header.setUint32(0, json.length);
      header.setUint32(4, binary.byteLength);
      prefix.set(json, 8);
      for (let offset = 0; offset < size; offset += frameSize - 1) {
        const end = Math.min(offset + frameSize - 1, size);
        const packet = new Uint8Array(end - offset + 1);
        packet[0] = (offset === 0 ? 1 : 0) | (end === size ? 2 : 0);
        if (offset < prefix.length) packet.set(prefix.subarray(offset, end), 1);
        if (end > prefix.length)
          packet.set(
            binary.subarray(
              Math.max(0, offset - prefix.length),
              end - prefix.length,
            ),
            1 + Math.max(0, prefix.length - offset),
          );
        const waitStarted = Date.now();
        while (!closed && bufferedAmount() > bufferLimit) {
          if (Date.now() - waitStarted >= 30000)
            throw new Error("直连发送超时");
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
        if (closed) throw new Error("直连已断开");
        sendFrame(packet);
      }
    });
    pending = operation.catch(fail).finally(() => {
      queuedBytes -= size;
    });
    return operation;
  }

  function frame(input) {
    if (closed) return;
    try {
      if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input))
        throw new Error("直连需要二进制帧");
      const packet = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      const flags = packet[0];
      if (
        packet.length < 2 ||
        packet.length > frameSize ||
        flags > 3 ||
        Boolean(flags & 1) === Boolean(incoming)
      )
        throw new Error("无效的直连帧顺序");
      let body = packet.subarray(1);
      if (flags & 1) {
        const header = new DataView(body.buffer, body.byteOffset, body.length);
        const jsonLength = header.getUint32(0);
        const binaryLength = header.getUint32(4);
        if (
          jsonLength < 2 ||
          jsonLength > maxJsonBytes ||
          binaryLength > MAX_RPC_MESSAGE_BYTES
        )
          throw new Error("无效的直连消息长度");
        incoming = {
          payload: new Uint8Array(jsonLength + binaryLength),
          offset: 0,
          jsonLength,
        };
        deadline = setTimeout(() => fail(new Error("直连接收超时")), 120000);
        body = body.subarray(8);
      }
      const { payload, offset, jsonLength } = incoming;
      if (
        offset + body.length > payload.length ||
        Boolean(flags & 2) !== (offset + body.length === payload.length)
      )
        throw new Error("无效的直连消息边界");
      payload.set(body, offset);
      incoming.offset += body.length;
      if (flags & 2) {
        incoming = null;
        clearTimeout(deadline);
        const message = JSON.parse(
          decoder.decode(payload.subarray(0, jsonLength)),
        );
        if (!message || typeof message.type !== "string")
          throw new Error("无效的直连消息类型");
        const binary = payload.subarray(jsonLength);
        if (message.type === "rpc")
          receive({ type: "rpc", text: decoder.decode(binary) });
        else {
          if (binary.length > MAX_P2P_BODY_BYTES)
            throw new Error("直连请求超过大小限制");
          receive(message, binary);
        }
      }
    } catch (error) {
      fail(error);
    }
  }

  return { send, frame, close: shutdown };
}
