const gatherTimeout = 6000;
const signalingTimeout = 22000;
const channelTimeout = 15000;

class RetryableP2pError extends Error {}

const signalingUnavailable = (message = "暂时无法通过 P2P 入口联系电脑。") =>
  new RetryableP2pError(message);
const directUnavailable = () =>
  new RetryableP2pError("已与电脑交换连接信息，但未能建立 P2P 直连。");

export async function connectP2pPeer(token, signal, onProgress) {
  try {
    return await openPeer(token, signal, onProgress);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof RetryableP2pError)) throw error;
    onProgress("retrying");
    return openPeer(token, signal, () => {});
  }
}

async function openPeer(token, signal, onProgress) {
  signal.throwIfAborted();
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  try {
    const channel = peer.createDataChannel("claudex", { ordered: true });
    channel.binaryType = "arraybuffer";
    onProgress("signaling");
    const timeout = AbortSignal.timeout(signalingTimeout);
    const exchange = AbortSignal.any([signal, timeout]);
    try {
      await exchangeOffer(peer, token, exchange);
    } catch (error) {
      signal.throwIfAborted();
      if (timeout.aborted) throw signalingUnavailable();
      throw error;
    }
    onProgress("connecting");
    await waitForChannel(peer, channel, signal);
    signal.throwIfAborted();
    return { peer, channel };
  } catch (error) {
    peer.close();
    throw error;
  }
}

async function exchangeOffer(peer, token, signal) {
  await peer.setLocalDescription(await peer.createOffer());
  await gatherIce(peer, signal);
  signal.throwIfAborted();
  const response = await fetch("/p2p/offer", {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, sdp: peer.localDescription.sdp }),
    signal,
  }).catch(() => {
    throw signalingUnavailable();
  });
  if (response.status === 401)
    throw Object.assign(
      new Error("此链接已失效或已被撤销，请获取新的 P2P 链接。"),
      {
        closeCode: 4401,
      },
    );
  const answer = await response.json().catch(() => null);
  if ([502, 503, 504].includes(response.status))
    throw signalingUnavailable(answer?.error);
  if (!response.ok)
    throw new Error(answer?.error || "P2P 入口暂时无法处理连接请求。");
  if (typeof answer?.sdp !== "string")
    throw new Error("P2P 入口未返回有效的连接信息。");
  signal.throwIfAborted();
  await peer
    .setRemoteDescription({ type: "answer", sdp: answer.sdp })
    .catch(() => {
      throw new Error("浏览器无法使用电脑返回的 P2P 连接信息。");
    });
}

function waitForChannel(peer, channel, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    const finish = (error) => {
      listeners.abort();
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const failed = () => finish(directUnavailable());
    const check = () => {
      if (
        peer.connectionState === "failed" ||
        peer.connectionState === "closed" ||
        channel.readyState === "closed"
      )
        failed();
      else if (channel.readyState === "open") finish();
    };
    const timer = setTimeout(() => {
      if (channel.readyState === "open") check();
      else failed();
    }, channelTimeout);
    signal.addEventListener("abort", () => finish(signal.reason), options);
    peer.addEventListener("connectionstatechange", check, options);
    channel.addEventListener("open", check, options);
    channel.addEventListener("close", failed, options);
    channel.addEventListener("error", failed, options);
    check();
  });
}

function gatherIce(peer, signal) {
  if (peer.iceGatheringState === "complete" || signal.aborted) return;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", check);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, gatherTimeout);
    peer.addEventListener("icegatheringstatechange", check);
    signal.addEventListener("abort", done, { once: true });
  });
}
