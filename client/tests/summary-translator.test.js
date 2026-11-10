import test from "node:test";
import assert from "node:assert/strict";
import {
  createSummaryTranslator,
  needsTranslation,
  translateSummaries,
} from "../src/infrastructure/summary-translator.js";

test("中文摘要与纯代码直接显示，英文摘要请求翻译", () => {
  assert.equal(needsTranslation("检查当前 Git 分支"), false);
  assert.equal(needsTranslation("`git status`"), false);
  assert.equal(needsTranslation("Identifying Git Branches"), true);
});
test("相同摘要合并进行中请求，完成后复用译文，新增原文独立翻译", async () => {
  const batches = [];
  const translator = createSummaryTranslator(async (texts) => {
    batches.push(texts);
    return texts.map((text) => "译文：" + text);
  });
  const first = translator.translate("Checking files");
  assert.equal(translator.translate("Checking files"), first);
  const second = translator.translate("Reviewing changes");
  await Promise.all([first, second]);
  assert.deepEqual(batches, [["Checking files", "Reviewing changes"]]);
  assert.equal(
    await translator.translate("Checking files"),
    "译文：Checking files",
  );
  assert.equal(
    await translator.translate("Checking files", "title"),
    "译文：Checking files",
  );
  assert.equal(translator.getCached("Checking files"), "译文：Checking files");
  assert.deepEqual(batches, [["Checking files", "Reviewing changes"]]);
  assert.equal(translator.getCached("Checking files again"), undefined);
  await translator.translate("Checking files again");
  assert.deepEqual(batches.at(-1), ["Checking files again"]);
  assert.equal(await translator.translate("已经是中文"), "已经是中文");
});

test("同一标签页会话恢复成功译文，新会话重新翻译，失败保留重试", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const batches = [];
  let failing = true;
  const request = async (texts) => {
    batches.push(texts);
    if (failing && texts.includes("Retry this summary"))
      throw new Error("模拟翻译失败");
    return texts.map((text) => "译文：" + text);
  };
  const first = createSummaryTranslator(request, storage);
  await first.translate("Stored summary");
  await assert.rejects(first.translate("Retry this summary"), /模拟翻译失败/);
  const reloaded = createSummaryTranslator(request, storage);
  assert.equal(reloaded.getCached("Stored summary"), "译文：Stored summary");
  assert.equal(reloaded.getCached("Retry this summary"), undefined);
  assert.equal(
    await reloaded.translate("Stored summary"),
    "译文：Stored summary",
  );
  assert.equal(batches.length, 2, "刷新后的成功译文直接读取会话缓存");
  failing = false;
  await reloaded.translate("Retry this summary");
  assert.equal(batches.length, 3, "失败原文重新请求");
  values.clear();
  const reopened = createSummaryTranslator(request, storage);
  assert.equal(reopened.getCached("Stored summary"), undefined);
  await reopened.translate("Stored summary");
  assert.equal(batches.length, 4, "新会话重新取得译文");
});

test("会话缓存损坏、存储不可读或写满时继续翻译并保留页面内缓存", async () => {
  for (const saved of ["{", "null", "{}", '[null,["Stored summary",123]]']) {
    let requests = 0;
    const translator = createSummaryTranslator(
      async () => {
        requests++;
        return ["检查摘要"];
      },
      { getItem: () => saved, setItem() {} },
    );
    assert.equal(await translator.translate("Stored summary"), "检查摘要");
    assert.equal(await translator.translate("Stored summary"), "检查摘要");
    assert.equal(requests, 1);
  }
  let requests = 0;
  const translator = createSummaryTranslator(
    async () => {
      requests++;
      return ["检查摘要"];
    },
    {
      getItem() {
        throw new Error("存储不可读");
      },
      setItem() {
        throw new Error("存储已满");
      },
    },
  );
  assert.equal(await translator.translate("Stored summary"), "检查摘要");
  assert.equal(await translator.translate("Stored summary"), "检查摘要");
  assert.equal(requests, 1);
});
test("翻译失败保留重试能力，缺失条目不会错配到其他摘要", async () => {
  let attempts = 0;
  const translator = createSummaryTranslator(async () =>
    ++attempts === 1 ? [] : ["检查文件"],
  );
  await assert.rejects(translator.translate("Checking files"), /不完整/);
  assert.equal(await translator.translate("Checking files"), "检查文件");
});

test("标题立即发送并越过正文队列，慢正文仍为后续标题保留容量", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches = [];
  let finishBody;
  const translator = createSummaryTranslator(async (texts) => {
    batches.push(texts);
    if (texts.includes("Slow background paragraph"))
      await new Promise((resolve) => (finishBody = resolve));
    return texts.map((text) => "译文：" + text);
  });
  const body = translator.translate("Slow background paragraph");
  const firstTitle = translator.translate("First heading", "title");
  t.mock.timers.tick(0);
  await firstTitle;
  assert.deepEqual(batches, [["First heading"]]);
  t.mock.timers.tick(100);
  assert.deepEqual(batches[1], ["Slow background paragraph"]);

  const nextBody = translator.translate("Next background paragraph");
  const nextTitle = translator.translate("Next heading", "title");
  t.mock.timers.tick(0);
  await nextTitle;
  assert.deepEqual(batches[2], ["Next heading"]);
  t.mock.timers.tick(1000);
  assert.equal(batches.length, 3);

  finishBody();
  await body;
  t.mock.timers.tick(100);
  await nextBody;
  assert.deepEqual(batches[3], ["Next background paragraph"]);
});

test("同一原文从正文提升为标题时立即发送并复用请求", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches = [];
  const translator = createSummaryTranslator(async (texts) => {
    batches.push(texts);
    return texts.map(() => "共享译文");
  });
  const body = translator.translate("Shared translation text");
  const title = translator.translate("Shared translation text", "title");
  assert.equal(title, body);
  t.mock.timers.tick(0);
  assert.equal(await title, "共享译文");
  assert.deepEqual(batches, [["Shared translation text"]]);
});

test("长历史按正文总量分批，单条失败后隔离重试并保留其他译文", async () => {
  const batches = [];
  const sources = Array.from(
    { length: 12 },
    (_, index) =>
      `Inspect item ${index}. ` + "Review the current settings. ".repeat(30),
  );
  const translator = createSummaryTranslator(async (texts) => {
    batches.push(texts);
    assert(texts.join("").length <= 3000, "历史正文请求限制总长度");
    if (texts.includes(sources[4])) throw new Error("模拟单条正文翻译失败");
    return texts.map((text) => "译文：" + text);
  });
  const results = await Promise.allSettled(
    sources.map((source) => translator.translate(source)),
  );
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, index === 4 ? "rejected" : "fulfilled");
    if (result.status === "fulfilled")
      assert.equal(result.value, "译文：" + sources[index].trim());
  }
  assert(batches.some((batch) => batch.length > 1));
  assert(
    batches.some((batch) => batch.length === 1 && batch[0] === sources[4]),
  );
});
