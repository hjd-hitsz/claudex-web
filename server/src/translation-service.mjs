import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createTranslationEngine,
  ModelStore,
} from "@claudex-web/translation-engine";

export function createTranslationService(
  { configDir, translationModelDir },
  createEngine = createTranslationEngine,
) {
  const file = join(configDir, "translation.json");
  let state = {
    enabled: false,
    state: "disabled",
    modelDirectory: translationModelDir,
    error: "",
  };
  let engine;
  let revision = 0;
  let initialized;
  let mutations = Promise.resolve();
  const snapshot = () => ({ ...state });
  async function stop() {
    revision++;
    const previous = engine;
    engine = null;
    await previous?.close();
  }
  function prepare() {
    const current = ++revision;
    const active = createEngine({
      directory: translationModelDir,
      onProgress: (progress) => {
        if (revision === current && state.enabled)
          state = { ...state, state: "downloading", progress };
      },
    });
    engine = active;
    state = { ...state, state: "preparing", error: "", progress: null };
    active.prepare().then(
      (model) => {
        if (revision === current && state.enabled)
          state = { ...state, state: "ready", model, progress: null };
      },
      (error) => {
        if (revision === current && state.enabled)
          state = {
            ...state,
            state: "error",
            error: error.message,
            progress: null,
          };
      },
    );
  }
  async function initialize() {
    return (initialized ??= (async () => {
      try {
        const saved = JSON.parse(await readFile(file, "utf8"));
        state.enabled = saved.enabled === true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (state.enabled) prepare();
      else {
        try {
          const model = await new ModelStore(translationModelDir).installed();
          if (model) state.model = { id: model.id, version: model.version };
        } catch (error) {
          state.error = error.message;
        }
      }
    })());
  }
  return {
    initialize,
    async status() {
      await initialize();
      return snapshot();
    },
    setEnabled(enabled) {
      const operation = mutations.then(async () => {
        await initialize();
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ enabled }), {
          mode: 0o600,
        });
        await rename(temporary, file);
        state = { ...state, enabled, error: "" };
        if (!enabled) {
          state = { ...state, state: "disabled", progress: null };
          await stop();
        } else if (!engine || state.state === "error") {
          await stop();
          prepare();
        }
        return snapshot();
      });
      mutations = operation.catch(() => {});
      return operation;
    },
    async translate(texts) {
      await initialize();
      if (!state.enabled || state.state !== "ready" || !engine)
        throw new Error("本地翻译模型尚未就绪，请在设置中查看下载状态");
      const current = revision;
      let result;
      try {
        result = await engine.translate(texts);
      } catch (error) {
        if (
          current === revision &&
          state.enabled &&
          error.code === "TRANSLATION_PROCESS_EXITED"
        ) {
          await stop();
          prepare();
        }
        throw error;
      }
      if (current !== revision || !state.enabled)
        throw new Error("思考内容翻译已关闭");
      return result;
    },
    async close() {
      await mutations;
      await stop();
    },
  };
}
