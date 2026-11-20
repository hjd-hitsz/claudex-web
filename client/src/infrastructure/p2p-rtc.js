const gatherTimeout = 6000;

export async function setupP2pPeer(peer, token, signal) {
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
  });
  if (response.status === 401)
    throw Object.assign(
      new Error("此链接已失效或已被撤销，请获取新的 P2P 链接。"),
      {
        closeCode: 4401,
      },
    );
  const answer = await response.json();
  if (!response.ok)
    throw new Error(answer.error || "暂时无法联系电脑，请稍后重试。");
  await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
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
