import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createTranslationSettings } from "../src/application/translation.js";

test("翻译开关立即反馈，保存期间暂停轮询，准备完成后恢复同步", async (t) => {
  let state = {
    auth: { authenticated: true },
    translation: { enabled: false, state: "disabled" },
  };
  const listeners = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const calls = [];
  let completeSave;
  const controller = createTranslationSettings({
    get: () => state,
    set,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(enabled) {
      calls.push(enabled);
      if (enabled === true)
        return new Promise((resolve) => {
          completeSave = resolve;
        });
      return {
        enabled: calls.length > 1,
        state: calls.length > 1 ? "ready" : "disabled",
      };
    },
  });
  const stop = controller.start();
  t.after(stop);
  await delay(0);
  const save = controller.setEnabled(true);
  assert.equal(state.translation.enabled, true);
  assert.equal(state.translation.state, "preparing");
  await delay(1100);
  assert.equal(calls.length, 2);
  completeSave({ enabled: true, state: "downloading" });
  await save;
  await delay(1100);
  assert.equal(state.translation.state, "ready");
  assert.equal(calls.length, 3);
  set({ auth: { authenticated: false } });
  assert.equal(state.translation.enabled, false);
});
