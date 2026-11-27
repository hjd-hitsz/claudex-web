import { createBackgroundOwnerReader } from "../../../../packages/background-terminal/activity.mjs";
import { CodexRpcError } from "./upstream.mjs";

export function createCodexBackgroundActivity(transport, background, upstream) {
  const readOwners = background?.available
    ? createBackgroundOwnerReader(background.directory, new URL(upstream).href)
    : null;
  let pending;

  async function extensionThreads() {
    if (!readOwners || !background.listening())
      return { running: [], complete: true };
    return readOwners();
  }

  async function hasNativeTerminal(threadId) {
    try {
      const { data } = await transport.call(
        "thread/backgroundTerminals/list",
        { threadId, limit: 1 },
        { trackThread: false },
      );
      return data.length > 0;
    } catch (error) {
      // With a validated ID from loaded/list, Invalid Request means the
      // thread unloaded before its terminals could be read.
      if (error instanceof CodexRpcError && error.code === -32600) return false;
      throw error;
    }
  }

  async function nativeThreads() {
    const loaded = new Set();
    const running = new Set();
    let complete = true;
    let cursor;
    do {
      const page = await transport.call("thread/loaded/list", {
        limit: 50,
        cursor,
      });
      const terminals = await Promise.allSettled(
        page.data.map(hasNativeTerminal),
      );
      for (const [index, result] of terminals.entries()) {
        const threadId = page.data[index];
        loaded.add(threadId);
        if (result.status === "rejected") complete = false;
        else if (result.value) running.add(threadId);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { loaded, running, complete };
  }

  async function observe() {
    if (!transport.ready) throw new Error("Codex 后端尚未就绪。");
    const [native, extension] = await Promise.allSettled([
      nativeThreads(),
      extensionThreads(),
    ]);
    if (native.status === "rejected") throw native.reason;
    if (!transport.ready) throw new Error("Codex 后端尚未就绪。");
    const { loaded, running, complete } = native.value;
    if (extension.status === "fulfilled")
      for (const threadId of extension.value.running) running.add(threadId);
    return {
      loaded,
      running,
      complete:
        complete &&
        extension.status === "fulfilled" &&
        extension.value.complete,
    };
  }

  return function backgroundActivity() {
    pending ??= observe().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
