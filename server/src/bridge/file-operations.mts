import { changesForPath, undoFileChanges } from "../file-undo.mjs";
import type { FileChangeItem } from "../file-undo.mjs";

type FileUndo = { threadId: string; turnId: string; path: string };
type FileOperationsOptions = {
  call: (
    method: "thread/read",
    params: { threadId: string; includeTurns: true },
  ) => Promise<{
    thread: {
      cwd: string;
      turns: { id: string; status: string; items: readonly FileChangeItem[] }[];
    };
  }>;
  activeTurns: { has(id: string): boolean };
  activeThreads: { has(id: string): boolean };
  broadcast: (message: {
    method: "lan/files/undone";
    params: FileUndo;
  }) => void;
};

export function createFileOperations({
  call,
  activeTurns,
  activeThreads,
  broadcast,
}: FileOperationsOptions) {
  const undoing = new Set<string>();
  const undoneFiles = new Map<string, FileUndo>();

  async function undo({ threadId, turnId, path }: FileUndo) {
    const key = JSON.stringify([threadId, turnId, path]);
    const previous = undoneFiles.get(key);
    if (previous) {
      broadcast({ method: "lan/files/undone", params: previous });
      return previous;
    }
    const isActive = () =>
      activeTurns.has(threadId) || activeThreads.has(threadId);
    if (isActive()) throw new Error("任务正在运行，请在结束后撤销修改。");
    if (undoing.has(threadId)) throw new Error("正在撤销文件修改，请稍候。");
    undoing.add(threadId);
    try {
      const { thread } = await call("thread/read", {
        threadId,
        includeTurns: true,
      });
      const turn = thread.turns.find((turn) => turn.id === turnId);
      if (!turn || turn.status === "inProgress")
        throw new Error("请重新加载此轮记录后再撤销。");
      await undoFileChanges({
        cwd: thread.cwd,
        changes: changesForPath(turn.items, thread.cwd, path),
        isActive,
      });
      const result = { threadId, turnId, path };
      undoneFiles.set(key, result);
      broadcast({ method: "lan/files/undone", params: result });
      return result;
    } finally {
      undoing.delete(threadId);
    }
  }

  return { undo, undoing, undoneFiles };
}
