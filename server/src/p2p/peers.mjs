import { randomUUID } from "node:crypto";
import { fail } from "./http.mjs";

function directOffer(sdp) {
  if (typeof sdp !== "string" || sdp.includes("\0")) return false;
  const media = sdp.match(/^m=.*$/gm) || [];
  const candidates = sdp.match(/^a=candidate:.*$/gm) || [];
  return (
    media.length === 1 &&
    /^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel\s*$/.test(
      media[0],
    ) &&
    candidates.length <= 64 &&
    !candidates.some((candidate) => /\s+typ\s+relay(?:\s|$)/i.test(candidate))
  );
}

export function createPeerRegistry(PeerConnection, connectPeer) {
  const peers = new Set();

  async function offer(link, sdp, signal) {
    if (!directOffer(sdp)) throw fail("无效的 WebRTC 直连请求", 400);
    if (
      peers.size >= 32 ||
      [...peers].filter((peer) => peer.link === link).length >= 4
    )
      throw fail("P2P 连接数已达上限，请关闭闲置页面后重试", 429);
    signal.throwIfAborted();
    const rtc = new PeerConnection(`claudex-${randomUUID()}`, {
      iceServers: ["stun:stun.l.google.com:19302"],
      disableAutoNegotiation: true,
      maxMessageSize: 16 * 1024,
    });
    let channel;
    let detach;
    let deadline;
    let stopWaiting;
    let dropDeadline;
    const peer = { link, dispose };
    peers.add(peer);

    function dispose() {
      if (!peers.delete(peer)) return;
      clearTimeout(deadline);
      clearTimeout(dropDeadline);
      stopWaiting?.(fail("这次 P2P 连接已关闭", 409));
      detach?.();
      channel?.close();
      rtc.close();
    }

    function open() {
      if (!peers.has(peer) || detach) return;
      clearTimeout(deadline);
      try {
        detach = connectPeer(channel, link);
      } catch {
        dispose();
      }
    }

    const onAborted = () => dispose();
    signal.addEventListener("abort", onAborted, { once: true });
    try {
      deadline = setTimeout(dispose, 30000);
      deadline.unref();
      rtc.onStateChange((state) => {
        clearTimeout(dropDeadline);
        if (!peers.has(peer)) return;
        if (state === "failed" || state === "closed") dispose();
        if (state === "disconnected") {
          dropDeadline = setTimeout(dispose, 15000);
          dropDeadline.unref();
        }
      });
      rtc.onDataChannel((incoming) => {
        if (!peers.has(peer) || channel || incoming.getLabel() !== "claudex") {
          incoming.close();
          return;
        }
        channel = incoming;
        channel.onClosed(dispose);
        channel.onError(dispose);
        channel.onOpen(open);
        if (channel.isOpen()) open();
      });
      const answer = await new Promise((resolve, reject) => {
        const finish = () => {
          try {
            const result = rtc.localDescription();
            if (!result?.sdp || result.type !== "answer")
              throw fail("暂时无法收集直连地址，请重试", 503);
            resolve({ sdp: result.sdp });
          } catch (error) {
            reject(error);
          }
        };
        const timer = setTimeout(() => stopWaiting?.(), 8000);
        timer.unref();
        stopWaiting = (error) => {
          clearTimeout(timer);
          stopWaiting = undefined;
          if (error) reject(error);
          else finish();
        };
        try {
          rtc.onGatheringStateChange((state) => {
            if (state === "complete") stopWaiting?.();
          });
          rtc.setRemoteDescription(sdp, "offer");
          rtc.setLocalDescription("answer");
        } catch {
          stopWaiting?.(fail("WebRTC 信令格式无效", 400));
        }
      });
      if (!peers.has(peer)) throw fail("这次 P2P 连接已关闭", 409);
      return answer;
    } catch (error) {
      dispose();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAborted);
    }
  }

  return {
    offer,
    close(link) {
      for (const peer of peers) if (!link || peer.link === link) peer.dispose();
    },
  };
}
