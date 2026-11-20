import { EventEmitter } from "node:events";
import { createP2pWire } from "../../shared/p2p-wire.mjs";
import { createPeerHttp } from "./p2p-http.mjs";

export function createPeerClient(channel, handleBusiness) {
  const peer = new EventEmitter();
  peer.readyState = 1;
  peer.detach = () => {
    if (peer.readyState === 3) return;
    peer.readyState = 3;
    wire.close();
    http.close();
    peer.emit("close");
  };
  const wire = createP2pWire({
    sendFrame: (frame) =>
      channel.sendMessageBinary(
        Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
      ),
    bufferedAmount: () => channel.bufferedAmount(),
    receive(message, bytes) {
      if (message.type === "rpc") peer.emit("message", message.text);
      else http.receive(message, bytes);
    },
    close() {
      peer.detach();
      channel.close();
    },
  });
  const http = createPeerHttp(handleBusiness, wire);
  peer.send = (text) => {
    wire.send({ type: "rpc", text }).catch(() => {});
  };
  channel.onMessage(wire.frame);
  return peer;
}
