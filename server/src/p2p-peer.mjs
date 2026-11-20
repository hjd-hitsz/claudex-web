import { EventEmitter } from "node:events";
import { createP2pWire } from "../../shared/p2p-wire.mjs";
import { createPeerHttp } from "./p2p-http.mjs";

export function createPeerClient(
  channel,
  handleBusiness,
  { authentication, linkId, onAuthenticated, onLogout },
) {
  const peer = new EventEmitter();
  const lifetime = new AbortController();
  const authorized = () =>
    peer.authSessionId && authentication.valid(peer.authSessionId, linkId);
  let untrack;
  let authenticating = false;
  peer.authLinkId = linkId;
  peer.readyState = 1;
  peer.detach = () => {
    if (peer.readyState === 3) return;
    peer.readyState = 3;
    lifetime.abort();
    wire.close();
    http.close();
    peer.emit("close");
  };
  peer.close = () => {
    peer.detach();
    channel.close();
  };

  async function authorize(message) {
    if (authenticating) {
      peer.close();
      return;
    }
    authenticating = true;
    try {
      if (message.action === "logout") {
        const id = peer.authSessionId;
        untrack?.();
        untrack = undefined;
        peer.authSessionId = undefined;
        http.close();
        if (id) onLogout(peer);
        await authentication.logoutPeer(linkId, id);
        await wire.send({
          type: "auth-result",
          session: { authenticated: false },
        });
        return;
      }
      const current = authorized();
      if (current || !["login", "resume"].includes(message.action))
        throw new Error("当前连接无法执行此登录操作。", { cause: 400 });
      const { id, token, session } =
        message.action === "login"
          ? await authentication.loginPeer(linkId, message, lifetime.signal)
          : authentication.resumePeer(linkId, message.token);
      lifetime.signal.throwIfAborted();
      if (id) untrack = authentication.attach(peer, id, linkId);
      await wire.send({
        type: "auth-result",
        session,
        ...(token && { token }),
      });
      if (id && authorized()) onAuthenticated(peer);
    } catch (error) {
      if (!lifetime.signal.aborted)
        await wire
          .send({
            type: "auth-result",
            error:
              typeof error.cause === "number"
                ? error.message
                : "登录暂不可用，请稍后重试。",
          })
          .catch(() => {});
    } finally {
      authenticating = false;
    }
  }

  const wire = createP2pWire({
    sendFrame: (frame) =>
      channel.sendMessageBinary(
        Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
      ),
    bufferedAmount: () => channel.bufferedAmount(),
    maxInboundBytes: () => (peer.authSessionId ? undefined : 8192),
    receive(message, bytes) {
      if (message.type === "auth") {
        if (bytes.length) peer.close();
        else void authorize(message);
      } else if (message.type === "rpc") {
        if (authorized()) peer.emit("message", message.text);
      } else http.receive(message, bytes);
    },
    close: peer.close,
  });
  const http = createPeerHttp((request, response, path) => {
    if (!authorized()) return response.writeHead(401).end();
    return handleBusiness(request, response, path);
  }, wire);
  peer.send = (text) => {
    if (authorized()) wire.send({ type: "rpc", text }).catch(() => {});
  };
  channel.onMessage(wire.frame);
  return peer;
}
