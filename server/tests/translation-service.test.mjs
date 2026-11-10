import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createTranslationService } from "../src/translation-service.mjs";

async function fixture(t, factory) {
  const configDir = await mkdtemp(join(tmpdir(), "translation-settings-"));
  const config = { configDir, translationModelDir: join(configDir, "models") };
  const service = createTranslationService(config, factory);
  t.after(async () => {
    await service.close();
    await rm(configDir, { recursive: true, force: true });
  });
  return { service, config };
}
test("默认关闭和读取设置保持零下载，开启一次合并重复点击并持久保存", async (t) => {
  let downloads = 0;
  let finish;
  const factory = () => ({
    prepare: () => {
      downloads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    close: async () => {},
    translate: async (texts) => texts.map(() => "译文"),
  });
  const { service, config } = await fixture(t, factory);
  assert.equal((await service.status()).enabled, false);
  assert.equal(downloads, 0);
  await Promise.all([service.setEnabled(true), service.setEnabled(true)]);
  assert.equal(downloads, 1);
  assert.deepEqual(
    JSON.parse(await readFile(join(config.configDir, "translation.json"))),
    { enabled: true },
  );
  await assert.rejects(service.translate(["English"]), /未就绪/);
  finish({ id: "edge-en-zh", version: "fixture" });
  await tick();
  assert.equal((await service.status()).state, "ready");
  assert.deepEqual(await service.translate(["English"]), ["译文"]);
  await service.setEnabled(false);
  assert.equal((await service.status()).enabled, false);
});
test("下载失败可重试，关闭后迟到的下载与翻译结果保持失效", async (t) => {
  let rejectDownload;
  let finishDownload;
  let finishTranslation;
  let attempt = 0;
  const { service } = await fixture(t, () => ({
    prepare: () =>
      new Promise((resolve, reject) => {
        attempt++;
        finishDownload = resolve;
        rejectDownload = reject;
      }),
    translate: () =>
      new Promise((resolve) => {
        finishTranslation = resolve;
      }),
    close: async () => {},
  }));
  await service.setEnabled(true);
  rejectDownload(new Error("下载校验失败"));
  await tick();
  assert.equal((await service.status()).error, "下载校验失败");
  await service.setEnabled(true);
  assert.equal(attempt, 2);
  await service.setEnabled(false);
  finishDownload({ id: "stale" });
  await tick();
  assert.equal((await service.status()).state, "disabled");
  await service.setEnabled(true);
  finishDownload({ id: "current" });
  await tick();
  const request = service.translate(["English"]);
  await tick();
  await service.setEnabled(false);
  finishTranslation(["迟到译文"]);
  await assert.rejects(request, /已关闭/);
});

test("推理进程异常结束后释放旧实例并准备新实例，失败请求保留错误供重试", async (t) => {
  let generations = 0;
  let closed = 0;
  const { service } = await fixture(t, () => {
    const generation = ++generations;
    return {
      prepare: async () => ({ id: "model", version: "fixture" }),
      translate: async () => {
        if (generation === 1)
          throw Object.assign(new Error("process ended"), {
            code: "TRANSLATION_PROCESS_EXITED",
          });
        return ["译文"];
      },
      close: async () => {
        closed++;
      },
    };
  });
  await service.setEnabled(true);
  await tick();
  await assert.rejects(service.translate(["English"]), /process ended/);
  await tick();
  assert.equal(generations, 2);
  assert.equal(closed, 1);
  assert.deepEqual(await service.translate(["English"]), ["译文"]);
});
