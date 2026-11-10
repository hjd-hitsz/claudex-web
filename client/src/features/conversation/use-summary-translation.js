import { useEffect, useState } from "react";
import { useStore, get } from "../../store.js";
import {
  createSummaryTranslator,
  needsTranslation,
  translateSummaries,
} from "../../infrastructure/summary-translator.js";

try {
  localStorage.removeItem("cx-summary-zh-v1");
} catch {
  /* 旧缓存清理失败时使用当前模型的独立缓存。 */
}
const translators = new Map();
let storage;
try {
  storage = sessionStorage;
} catch {
  /* 浏览器禁用会话存储时复用页面内存。 */
}
function translatorFor(key) {
  if (!translators.has(key))
    translators.set(
      key,
      createSummaryTranslator(
        (texts) => {
          const state = get().translation;
          if (
            !state.enabled ||
            state.state !== "ready" ||
            `${state.model?.id}:${state.model?.version}` !== key
          )
            throw new Error("翻译已关闭或模型尚未就绪");
          return translateSummaries(texts);
        },
        storage,
        `cx-summary-zh-edge-v1:${key}`,
      ),
    );
  return translators.get(key);
}
export function useSummaryTranslation(
  text,
  priority = "body",
  complete = false,
) {
  const { translation } = useStore();
  const key = `${translation.model?.id}:${translation.model?.version}`;
  const enabled =
    translation.enabled &&
    translation.state === "ready" &&
    complete &&
    needsTranslation(text);
  const translator = enabled ? translatorFor(key) : null;
  const cached = translator?.getCached(text);
  const [result, setResult] = useState({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || cached !== undefined) return;
    let active = true;
    translator.translate(text, priority).then(
      (value) => {
        if (active) setResult({ source: text, key, value });
      },
      (error) => {
        if (active) setResult({ source: text, key, error: error.message });
      },
    );
    return () => {
      active = false;
    };
  }, [text, key, enabled, cached, attempt, priority, translator]);
  const current =
    enabled && result.source === text && result.key === key ? result : {};
  return {
    text: enabled ? (cached ?? current.value ?? text) : text,
    translated:
      enabled && (cached !== undefined || current.value !== undefined),
    pending:
      enabled && cached === undefined && !current.value && !current.error,
    error: current.error,
    retry: () => {
      setResult({});
      setAttempt((value) => value + 1);
    },
  };
}
