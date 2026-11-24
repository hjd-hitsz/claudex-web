importScripts("/notification-worker.js");

const requestTimeout = 20000;
const maximumRequestBytes = 512 * 1024;
const maximumCreditWindow = 8;
const forwardedPath =
  /^\/api\/(?:files|media|translate|translation|maintenance(?:\/(?:check|update|restart))?)$/;

function failure(message, status = 503) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function requestFromPage(client, request, url, body) {
  const { port1: port, port2: remotePort } = new MessageChannel();
  let timer, stream, resolveResponse, resolveDone, finished;
  let outstanding = 0;
  const response = new Promise((resolve) => (resolveResponse = resolve));
  const done = new Promise((resolve) => (resolveDone = resolve));

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    port.close();
    resolveDone();
  }
  function stop(message) {
    if (finished) return;
    port.postMessage("cancel");
    if (stream) stream.error(new Error(message));
    else resolveResponse(failure(message));
    finish();
  }
  function abort() {
    stop("文件或业务请求已取消。");
  }
  function waitForMessage() {
    clearTimeout(timer);
    timer = setTimeout(
      () => stop("等待电脑响应超时，请检查 P2P 连接后重试。"),
      requestTimeout,
    );
  }
  port.onmessage = ({ data }) => {
    if (finished) return;
    clearTimeout(timer);
    switch (data.type) {
      case "response": {
        const noBody =
          request.method === "HEAD" || [204, 205, 304].includes(data.status);
        const creditWindow = Number.isSafeInteger(data.creditWindow)
          ? Math.max(1, Math.min(maximumCreditWindow, data.creditWindow))
          : 1;
        const content = noBody
          ? null
          : new ReadableStream(
              {
                start(controller) {
                  stream = controller;
                },
                pull(controller) {
                  // Each credit reserves one slot in the stream's read-ahead buffer.
                  const available = controller.desiredSize;
                  while (outstanding < available) {
                    port.postMessage("pull");
                    outstanding++;
                  }
                  if (outstanding) waitForMessage();
                },
                cancel() {
                  port.postMessage("cancel");
                  finish();
                },
              },
              { highWaterMark: creditWindow },
            );
        resolveResponse(new Response(content, data));
        if (noBody) {
          port.postMessage("cancel");
          finish();
        }
        break;
      }
      case "data":
        outstanding--;
        stream?.enqueue(data.bytes);
        if (outstanding > 0) waitForMessage();
        break;
      case "end":
        stream?.close();
        finish();
        break;
      case "error":
        stop(data.message);
        break;
    }
  };
  request.signal.addEventListener("abort", abort, { once: true });
  client.postMessage(
    {
      type: "claudex-p2p-http",
      url: url.pathname + url.search,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
    },
    body ? [remotePort, body] : [remotePort],
  );
  if (request.signal.aborted) abort();
  else waitForMessage();
  return { response, done };
}

function isP2pClient(client) {
  return client && new URL(client.url).pathname === "/p2p";
}

self.addEventListener("message", (event) => {
  if (
    event.data?.type === "claudex-p2p-claim-view" &&
    event.source?.type === "window" &&
    isP2pClient(event.source)
  )
    event.waitUntil(self.clients.claim());
});

async function findFileView(id) {
  const windows = await self.clients.matchAll({ type: "window" });
  return Promise.any(
    windows.filter(isP2pClient).map(
      (client) =>
        new Promise((resolve, reject) => {
          const { port1: port, port2: remotePort } = new MessageChannel();
          function answer(matches) {
            clearTimeout(timer);
            port.close();
            if (matches) resolve(client);
            else reject();
          }
          const timer = setTimeout(() => answer(false), 1000);
          port.onmessage = ({ data }) => answer(data === true);
          client.postMessage({ type: "claudex-p2p-find-view", id }, [
            remotePort,
          ]);
        }),
    ),
  ).catch(() => null);
}

async function forward(event, url) {
  const { request } = event;
  const view = url.searchParams.get("p2p-view");
  // 浏览器为下载和 PDF 内嵌导航提供子框架标识，渲染页负责对应的直连。
  const client =
    url.pathname === "/api/files" && view && request.method === "GET"
      ? await findFileView(view)
      : await self.clients.get(event.clientId);
  if (!client || new URL(client.url).pathname !== "/p2p")
    return { response: failure("请在已连接的 P2P 网页中打开文件或发起请求。") };
  if (view) url.searchParams.delete("p2p-view");
  const body = request.body ? await request.arrayBuffer() : null;
  if (body && body.byteLength > maximumRequestBytes)
    return { response: failure("请求内容过大。", 413) };
  return requestFromPage(client, request, url, body);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/api/"))
    return;
  if (!forwardedPath.test(url.pathname)) {
    event.respondWith(failure("此接口不支持 P2P 访问。", 404));
    return;
  }
  const transfer = forward(event, url).catch(() => ({
    response: failure("P2P 请求失败，请重新连接后重试。"),
  }));
  event.respondWith(transfer.then(({ response }) => response));
  event.waitUntil(transfer.then(({ done }) => done));
});
