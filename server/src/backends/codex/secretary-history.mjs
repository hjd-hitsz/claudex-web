import { readFile } from "node:fs/promises";
import { codexSecretaryHistoryPath } from "../../../../packages/background-terminal/secretary-history-policy.mjs";
import { writePrivateFile } from "../../private-file.mjs";
import { createHistoryPages } from "../history-pages.mjs";

function message(role, content) {
  return { type: "message", role, content };
}

function previousItem(item) {
  if (item.type === "userMessage") {
    const content = item.content.flatMap((part) => {
      if (part.type === "text")
        return [{ type: "input_text", text: part.text }];
      if (part.type === "image")
        return [{ type: "input_image", image_url: part.url }];
      if (part.type === "localImage")
        return [
          {
            type: "input_text",
            text: JSON.stringify({ attachment: part.path }),
          },
        ];
      return [];
    });
    return content.length ? [message("user", content)] : [];
  }
  if (item.type === "agentMessage")
    return [message("assistant", [{ type: "output_text", text: item.text }])];
  if (item.type === "commandExecution" && item.status !== "inProgress")
    return toolResult(
      "exec_command",
      item.status,
      item.aggregatedOutput,
      item.exitCode,
    );
  if (
    ["mcpToolCall", "dynamicToolCall"].includes(item.type) &&
    item.status !== "inProgress"
  )
    return toolResult(item.tool, item.status, item.result ?? item.contentItems);
  return [];
}

function toolResult(tool, status, output, exitCode) {
  return [
    message("assistant", [
      {
        type: "output_text",
        text: JSON.stringify({ tool, status, output, exitCode }),
      },
    ]),
  ];
}

async function nativeTurns(call, threadId) {
  const pages = [];
  let cursor;
  do {
    const page = await call("thread/turns/list", {
      threadId,
      cursor,
      itemsView: "full",
      sortDirection: "asc",
      limit: 100,
    });
    pages.push(page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return pages.flat();
}

function historyPage(records, { sortDirection, limit = 50, cursor }) {
  const offset = cursor == null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("分页位置无效");
  const ordered = sortDirection === "asc" ? records : records.toReversed();
  const data = ordered.slice(
    offset,
    offset + Math.max(1, Math.min(limit, 200)),
  );
  const next = offset + data.length;
  return { data, nextCursor: next < records.length ? String(next) : null };
}

export function createCodexSecretaryHistory(call, directory, start, fork) {
  const location = (id) => codexSecretaryHistoryPath(directory, id);
  async function readPrefix(id) {
    try {
      return JSON.parse(await readFile(location(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  const save = (id, prefix) =>
    writePrivateFile(location(id), JSON.stringify(prefix));
  const readSource = (threadId) =>
    call("thread/read", { threadId, includeTurns: false });
  const pages = createHistoryPages(
    async (id) => [
      ...((await readPrefix(id))?.turns ?? []),
      ...(await nativeTurns(call, id)),
    ],
    historyPage,
  );
  async function create(source, turns, role, name) {
    const retained = turns.map((turn) => ({
      ...turn,
      items: turn.items.filter((item) => previousItem(item).length),
    }));
    const items = retained.flatMap((turn) => turn.items.flatMap(previousItem));
    const next = await start(source, role);
    const threadId = next.thread.id;
    try {
      if (items.length) await call("thread/inject_items", { threadId, items });
      if (name) await call("thread/name/set", { threadId, name });
      await save(threadId, { turns: retained, sourceId: source.id });
    } catch (error) {
      await call("thread/archive", { threadId }).catch(() => {});
      throw error;
    }
    return {
      ...next,
      thread: { ...next.thread, name, forkedFromId: source.id },
    };
  }
  async function continuation({ threadId, model }, role) {
    const { thread } = await readSource(threadId);
    if (thread.status?.type === "active")
      throw new Error("请等待当前轮结束后开启委派模式。");
    const inherited = (await readPrefix(threadId))?.turns ?? [];
    return create(
      { ...thread, ...(model && { model }) },
      [...inherited, ...(await nativeTurns(call, threadId))],
      role,
      thread.name ? thread.name + " · 秘书" : undefined,
    );
  }
  return {
    close: pages.close,
    async request(method, params, role) {
      const { threadId } = params;
      if (method === "lan/delegation/secretary/continue")
        return continuation(params, role);
      if (
        !threadId ||
        ![
          "thread/read",
          "thread/turns/list",
          "thread/items/list",
          "thread/fork",
          "thread/revert",
        ].includes(method)
      )
        return;
      const prefix = await readPrefix(threadId);
      if (!prefix) return;
      if (method === "thread/read") {
        const result = await call(method, params);
        return {
          ...result,
          thread: {
            ...result.thread,
            forkedFromId: prefix.sourceId,
            ...(params.includeTurns && {
              turns: [...prefix.turns, ...(result.thread.turns ?? [])],
            }),
          },
        };
      }
      if (method === "thread/fork") {
        const at = prefix.turns.findIndex(
          (turn) => turn.id === params.lastTurnId,
        );
        if (at >= 0) {
          const { thread } = await readSource(threadId);
          return create(thread, prefix.turns.slice(0, at + 1), role);
        }
        const result = await fork(params, role);
        await save(result.thread.id, prefix);
        return result;
      }
      if (method === "thread/revert") {
        if (prefix.turns.some((turn) => turn.id === params.beforeTurnId))
          throw new Error("这条消息来自原对话，可从此处创建分支后继续。");
        return;
      }
      return pages.read(method, params);
    },
  };
}
