import { setGlobalProxyFromEnv } from "node:http";
import { join } from "node:path";
import { ModelStore } from "./model-store.mjs";
import { EdgeTranslation } from "./inference.mjs";
process.env.ORT_DISABLE_TELEMETRY = "1";
setGlobalProxyFromEnv();
let store;
const reply = (message) => {
  if (process.connected) process.send(message);
};
const controller = new AbortController();
let engine;
let model;
let queue = Promise.resolve();
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  controller.abort(new Error("翻译已关闭"));
  queue.finally(async () => {
    await engine?.close();
    if (process.connected) process.disconnect();
  });
}
process.on("disconnect", close);
process.on("message", (message) => {
  if (message.action === "close") {
    close();
    return;
  }
  const task = queue.then(async () => {
    controller.signal.throwIfAborted();
    if (message.action === "prepare") {
      if (model) return model;
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new Error("本地翻译引擎目前支持 Linux x64");
      const glibc =
        process.report.getReport().header.glibcVersionRuntime || "0.0";
      const [major, minor] = glibc.split(".").map(Number);
      if (major < 2 || (major === 2 && minor < 34))
        throw new Error("本地翻译引擎需要 glibc 2.34 或更高版本");
      store ??= new ModelStore(message.directory);
      const installed = await store.prepare(controller.signal, (progress) =>
        reply({ progress }),
      );
      engine = new EdgeTranslation();
      try {
        await engine.load(
          join(installed.directory, "model"),
          join(installed.directory, "runtime"),
        );
      } catch (error) {
        await engine.close();
        engine = null;
        throw error;
      }
      model = {
        id: installed.id,
        version: installed.version,
        directory: installed.directory,
      };
      return model;
    }
    if (!engine) throw new Error("翻译模型尚未就绪");
    const result = [];
    for (const text of message.texts) {
      controller.signal.throwIfAborted();
      result.push((await engine.translate(text, controller.signal)).text);
    }
    return result;
  });
  queue = task.catch(() => {});
  task.then(
    (result) => reply({ id: message.id, result }),
    (error) =>
      reply({
        id: message.id,
        error: error.cause?.code
          ? `${error.message} (${error.cause.code})`
          : error.message,
      }),
  );
});
