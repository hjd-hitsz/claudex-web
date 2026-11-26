import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryPages } from "../src/backends/history-pages.mjs";
import { page } from "../src/backends/claude/history.mjs";

test("Claude 分页游标复用原生历史快照，新读取看见实时追加和原地编辑", async (t) => {
  let reads = 0;
  let source = ["a", "b", "c", "d"];
  const history = createHistoryPages(async () => {
    reads++;
    return [{ id: "turn", items: source.map((id) => ({ id })) }];
  }, page);
  t.after(history.close);
  const params = { threadId: "fixture", sortDirection: "desc", limit: 2 };
  const read = (input) =>
    history.read("thread/items/list", { ...params, ...input });
  const ids = ({ data }) => data.map(({ item }) => item.id);
  const first = await read();
  source.push("e");
  const next = await read({ cursor: first.nextCursor });
  assert.deepEqual(ids(first), ["d", "c"]);
  assert.deepEqual(ids(next), ["b", "a"]);
  assert.ok(!next.nextCursor);
  assert.deepEqual(await read({ cursor: first.nextCursor }), next);
  assert.equal(reads, 1);
  await assert.rejects(
    read({ threadId: "other", cursor: first.nextCursor }),
    /分页位置无效/,
  );
  await assert.rejects(
    history.read("thread/turns/list", {
      ...params,
      cursor: first.nextCursor,
    }),
    /分页位置无效/,
  );
  assert.deepEqual(ids(await read()), ["e", "d"]);
  history.invalidate("fixture");
  source = ["a", "x", "y", "z"];
  assert.deepEqual(ids(await read({ cursor: first.nextCursor })), ["x", "a"]);
  assert.deepEqual(ids(await read({ cursor: "2" })), ["x", "a"]);
});
