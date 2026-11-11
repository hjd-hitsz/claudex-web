import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
export { ModelStore, defaultModelDirectory } from "./model-store.mjs";
export { modelId } from "./catalog.mjs";

export function createTranslationEngine({ directory, onProgress = () => {} }) {
  let worker;
  let exited;
  let failure;
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  function fail(error) {
    error.code = "TRANSLATION_PROCESS_EXITED";
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  function call(action, texts) {
    if (closed || failure)
      return Promise.reject(failure || new Error("翻译引擎已关闭"));
    if (!worker) {
      worker = fork(
        fileURLToPath(new URL("./worker.mjs", import.meta.url)),
        [],
        {
          execArgv: [],
          env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      let diagnostic = "";
      worker.stderr.on("data", (bytes) => {
        diagnostic = (diagnostic + bytes).slice(-2000);
      });
      exited = new Promise((resolve) => worker.once("close", resolve));
      worker.on("message", (message) => {
        if (message.progress) {
          onProgress(message.progress);
          return;
        }
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error));
        else request?.resolve(message.result);
      });
      worker.on("error", fail);
      worker.on("exit", () =>
        fail(new Error(diagnostic || "翻译工作进程已结束")),
      );
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.send({ id, action, texts, directory });
    });
  }
  return {
    prepare: () => call("prepare"),
    translate: (texts) => call("translate", texts),
    async close() {
      if (!closed) {
        closed = true;
        if (worker && !failure) worker.send({ action: "close" });
        fail(new Error("翻译已关闭"));
      }
      await exited;
    },
  };
}
