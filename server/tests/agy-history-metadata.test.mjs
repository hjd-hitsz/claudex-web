import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  agySessionStatePath,
  createAgyStore,
} from "../src/backends/agy/session-store.mjs";
import {
  assertHistoryIdle,
  createAgyNativeHistoryActions,
} from "../src/backends/agy/tmp_function/native-history-actions.mjs";
import {
  annotationTitle,
  openHistoryIndex,
  verifyNativeConversation,
  withoutCliSummary,
  withoutJetboxSummary,
} from "../src/backends/agy/tmp_function/native-history-index.mjs";
import {
  lockNativeHistory,
  recoverNativeHistory,
} from "../src/backends/agy/tmp_function/native-history-transaction.mjs";

const nativeId = "aaaaaaaa-2222-4333-8444-bbbbbbbbbbbb";
const controlId = "cccccccc-2222-4333-8444-dddddddddddd";
const session = { id: "web", nativeId, name: "Before", turns: [] };
const dbPath = "conversations/" + nativeId + ".db";
const controlDbPath = "conversations/" + controlId + ".db";
const annotation = "annotations/" + nativeId + ".pbtxt";
const summaryDb = "conversation_summaries.db";
const state = (target = session) => ({
  sessions: { web: { ...target } },
  tasks: {},
  notices: {},
});
const binary = (number, bytes) =>
  Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
const record = (id, title) =>
  binary(
    1,
    Buffer.concat([binary(1, Buffer.from(id)), binary(2, Buffer.from(title))]),
  );

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "agy-metadata-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const dir of [
    "annotations",
    "conversations",
    "cache",
    "brain/" + nativeId,
  ])
    await mkdir(join(directory, dir), { recursive: true });
  for (const [path, id] of [
    [dbPath, nativeId],
    [controlDbPath, controlId],
  ]) {
    const db = new DatabaseSync(join(directory, path));
    db.exec(
      "PRAGMA user_version = 1; PRAGMA journal_mode = WAL; CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT)",
    );
    db.prepare("INSERT INTO trajectory_meta VALUES ('fixture', ?)").run(id);
    db.close();
  }
  const summaries = new DatabaseSync(join(directory, summaryDb));
  summaries.exec(`
    PRAGMA user_version = 3;
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', preview TEXT,
      step_count INTEGER, last_modified_time DATETIME, workspace_uris TEXT,
      status TEXT NOT NULL DEFAULT '', source TEXT, project_id TEXT, agent_name TEXT,
      parent_conversation_id TEXT, nesting_depth INTEGER, battle_id TEXT,
      winning_conversation_id TEXT, not_fully_idle NUMERIC DEFAULT FALSE, killed NUMERIC,
      last_user_input_time DATETIME, last_user_input_step_index INTEGER, app_data_dir TEXT,
      raw_summary BLOB, group_id TEXT
    );
  `);
  const insert = summaries.prepare(
    "INSERT INTO conversation_summaries (conversation_id,title,app_data_dir,raw_summary) VALUES (?,?,'antigravity-cli',?)",
  );
  insert.run(nativeId, "Before", Buffer.from([0, 255]));
  insert.run(controlId, "Control", Buffer.from([3]));
  summaries.close();
  const files = {
    [annotation]: 'title:"Before" tags:"retain"',
    "jetbox_summaries_proto.pb": Buffer.concat([
      record(nativeId, "target"),
      record(controlId, "control"),
    ]),
    "cache/conversation_metadata.json": JSON.stringify({
      conversations: {
        [nativeId]: { summary: { Title: "Before" } },
        [controlId]: {},
      },
    }),
    "cache/last_conversations.json": JSON.stringify({
      "/target": nativeId,
      "/other": controlId,
    }),
    ["brain/" + nativeId + "/transcript.jsonl"]: "{}\n",
  };
  for (const [path, content] of Object.entries(files))
    await writeFile(join(directory, path), content);
  const read = (path) => readFile(join(directory, path));
  const rows = () => {
    const db = openHistoryIndex(directory);
    try {
      return db
        .prepare(
          "SELECT conversation_id, title, hex(raw_summary) AS raw FROM conversation_summaries ORDER BY conversation_id",
        )
        .all();
    } finally {
      db.close();
    }
  };
  return { directory, read, rows, paths: [dbPath, ...Object.keys(files)] };
}

function operations(
  directory,
  {
    data = state(),
    occupancy = () => ({}),
    readExecutorBackground = async () => ({ terminals: [], jobs: [] }),
    failure,
    agent = { name: "Antigravity ACP Server", version: "1.5.18" },
  } = {},
) {
  const events = [];
  const sessions = {
    rewriting: new Set(),
    agentInfo: () => agent,
    closeForHistory: async () => {},
  };
  const history = createAgyNativeHistoryActions({
    directory,
    store: {
      read: async () => data,
      session: (data, id) => data.sessions[id],
      change: async (change) => {
        if (failure) throw failure;
        change(data);
      },
    },
    sessions,
    occupancy,
    readExecutorBackground,
    changed: (...args) => events.push(args),
  });
  const apply = (method, params = {}) =>
    history.apply(method, data.sessions.web, params, data);
  return { apply, events, data, sessions };
}

test("agy 历史只修改已核对的 annotation、缓存条目和 SQLite 会话身份", async (t) => {
  const before = Buffer.from(
    'tags:"title:dummy" title:"Before\\" with quotes" pinned:true',
  );
  assert.equal(
    annotationTitle(before, '中文 "标题"\\线').toString(),
    'tags:"title:dummy" title:"中文 \\"标题\\"\\\\线" pinned:true',
  );
  assert.throws(
    () => annotationTitle(Buffer.from('title:"a" title:"b"'), "new"),
    /格式/,
  );
  const binary = Buffer.concat([
    record(nativeId, "target"),
    record(controlId, "control"),
  ]);
  assert.deepEqual(
    withoutJetboxSummary(binary, nativeId),
    record(controlId, "control"),
  );
  assert.throws(
    () => withoutJetboxSummary(binary.subarray(0, -1), nativeId),
    /格式/,
  );
  const json = Buffer.from('{"conversations":{}}');
  assert.equal(
    withoutCliSummary(json, "cache/conversation_metadata.json", nativeId),
    json,
  );
  const { directory } = await fixture(t);
  assert.throws(
    () => verifyNativeConversation(directory, dbPath, controlId),
    /格式/,
  );
  const occupied = new DatabaseSync(join(directory, dbPath));
  occupied.exec("BEGIN IMMEDIATE");
  assert.throws(
    () => verifyNativeConversation(directory, dbPath, nativeId),
    /仍在使用/,
  );
  occupied.close();
  verifyNativeConversation(directory, dbPath, nativeId);
  const db = new DatabaseSync(join(directory, summaryDb));
  db.exec("PRAGMA user_version = 4");
  db.close();
  assert.throws(() => openHistoryIndex(directory), /格式/);
});

async function crashDuringHistorySave(
  directory,
  stateDirectory,
  method,
  point,
) {
  const child = fork(
    new URL("../../tests/helpers/agy-history-crash-child.mjs", import.meta.url),
    [directory, stateDirectory, method, point],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(child, "exit");
  try {
    const [message] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10000) }),
      exited.then(([code, signal]) => {
        throw new Error(`测试子进程在指定崩溃点之前退出（${signal || code}）`);
      }),
    ]);
    assert.deepEqual(message, { point });
    child.kill("SIGKILL");
    assert.deepEqual(await exited, [null, "SIGKILL"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
}

for (const action of ["delete", "archive"]) {
  for (const saved of [false, true]) {
    test(`agy ${action} 后、${saved ? "网页状态已保存" : "网页状态尚未保存"}时遭遇 SIGKILL`, async (t) => {
      const { directory, read, rows, paths } = await fixture(t);
      const stateDirectory = join(directory, "web");
      const store = createAgyStore(stateDirectory);
      await store.change((data) => {
        data.sessions.web = { ...session, previousNativeId: controlId };
      });
      const stateFile = agySessionStatePath(stateDirectory);
      const originalState = await readFile(stateFile);
      const original = await Promise.all(paths.map(read));
      const originalRows = rows();
      const previousDb = await read(controlDbPath);
      const parkPath = ".claudex-history/archived/" + nativeId + ".db";
      const transactions = join(directory, ".claudex-history", "transactions");

      await crashDuringHistorySave(
        directory,
        stateDirectory,
        "thread/" + action,
        saved ? "after-save" : "before-save",
      );
      const backups = await readdir(transactions);
      assert.equal(backups.length, 1);
      const journal = JSON.parse(
        await readFile(join(transactions, backups[0], "journal.json"), "utf8"),
      );
      assert.equal(journal.nativeId, nativeId);
      const crashedState = await store.read();
      const stateAtCrash = await readFile(stateFile);
      if (saved) {
        assert.equal(
          crashedState.sessions.web.nativeHistoryOperation,
          journal.key,
        );
        assert.equal(
          crashedState.sessions.web[
            action === "delete" ? "deleted" : "archived"
          ],
          true,
        );
      } else {
        assert.deepEqual(stateAtCrash, originalState);
      }
      const absent = (path) => assert.rejects(read(path), { code: "ENOENT" });
      async function assertApplied() {
        await absent(dbPath);
        if (action === "archive") {
          assert.deepEqual(await read(parkPath), original[0]);
          assert.deepEqual(
            await Promise.all(paths.slice(1).map(read)),
            original.slice(1),
          );
          assert.deepEqual(rows(), originalRows);
        } else {
          await absent(annotation);
          await absent("brain/" + nativeId + "/transcript.jsonl");
          assert.deepEqual(rows(), [originalRows[1]]);
          assert.deepEqual(
            await read("jetbox_summaries_proto.pb"),
            record(controlId, "control"),
          );
          assert.deepEqual(
            JSON.parse(await read("cache/conversation_metadata.json")),
            { conversations: { [controlId]: {} } },
          );
          assert.deepEqual(
            JSON.parse(await read("cache/last_conversations.json")),
            { "/other": controlId },
          );
        }
      }
      await assertApplied();

      await recoverNativeHistory(directory, crashedState.sessions);
      await recoverNativeHistory(directory, crashedState.sessions);
      assert.deepEqual(await readdir(transactions), []);
      assert.deepEqual(await readFile(stateFile), stateAtCrash);
      assert.deepEqual(await read(controlDbPath), previousDb);
      if (saved) {
        await assertApplied();
      } else {
        assert.deepEqual(await Promise.all(paths.map(read)), original);
        assert.deepEqual(rows(), originalRows);
        await absent(parkPath);
      }
    });
  }
}

test("agy 拒绝带轮次、队列、委派、回投或后台引用的删除", async (t) => {
  const { directory, read } = await fixture(t);
  const method = "thread/delete";
  for (const work of [
    { active: true },
    { pending: true },
    { compacting: true },
    { delivering: true },
  ])
    assert.throws(() => assertHistoryIdle(method, session, state(), work));
  const data = state();
  data.tasks.related = { parentId: session.id, status: "unknown" };
  assert.throws(() => assertHistoryIdle(method, session, data, {}), /委派任务/);
  data.tasks.related.status = "completed";
  data.tasks.related.executor = { threadId: "executor" };
  const background = operations(directory, {
    data,
    readExecutorBackground: async () => ({ terminals: [{}], jobs: [] }),
  });
  await assert.rejects(background.apply(method), /后台终端/);
  const unavailable = operations(directory, {
    data,
    readExecutorBackground: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(unavailable.apply(method), /无法核对/);
  assert.equal(background.sessions.rewriting.size, 0);
  assert.equal(
    (await read(annotation)).toString(),
    'title:"Before" tags:"retain"',
  );
  const lock = await lockNativeHistory(directory, nativeId);
  try {
    const busy = operations(directory);
    await assert.rejects(busy.apply(method), /关闭该 agy 原生会话/);
    assert.deepEqual(busy.events, []);
  } finally {
    await lock.close();
  }
});

test("agy 删除时网页状态保存失败，恢复文件、二进制摘要和目标索引行", async (t) => {
  const { directory, read, rows, paths } = await fixture(t);
  const original = await Promise.all(paths.map(read));
  const originalRows = rows();
  const failed = operations(directory, {
    failure: new Error("写入网页状态失败"),
  });
  await assert.rejects(failed.apply("thread/delete"), /写入网页状态失败/);
  assert.deepEqual(await Promise.all(paths.map(read)), original);
  assert.deepEqual(rows(), originalRows);
  assert.deepEqual(failed.events, []);
  assert.deepEqual(
    await readdir(join(directory, ".claudex-history", "transactions")),
    [],
  );
  const result = operations(directory);
  await result.apply("thread/delete");
  assert.equal(result.data.sessions.web.deleted, true);
  assert.deepEqual(rows(), [originalRows[1]]);
  await assert.rejects(read(dbPath), { code: "ENOENT" });
  await assert.rejects(read(annotation), { code: "ENOENT" });
  assert.deepEqual(
    await read("jetbox_summaries_proto.pb"),
    record(controlId, "control"),
  );
});

test("没有 agy 原生映射或使用模拟运行时的操作不触碰原生历史", async (t) => {
  const { directory, read } = await fixture(t);
  const original = await read(annotation);
  for (const options of [
    { data: state({ ...session, nativeId: undefined }) },
    { agent: { name: "Fixture", version: "1.5.18" } },
  ]) {
    const history = operations(directory, options);
    await history.apply("thread/name/set", { name: "Local only" });
    assert.equal(history.data.sessions.web.name, "Local only");
    assert.deepEqual(await read(annotation), original);
    assert.deepEqual(history.events, [
      ["thread/name/updated", "web", "Local only"],
    ]);
  }
  const incompatible = operations(directory, {
    agent: { name: "Antigravity ACP Server", version: "1.6.0" },
  });
  await assert.rejects(incompatible.apply("thread/delete"), /尚未验证/);
  assert.deepEqual(await read(annotation), original);
  assert.equal(
    execFileSync("flock", ["--version"], { encoding: "utf8" }).startsWith(
      "flock",
    ),
    true,
  );
});
