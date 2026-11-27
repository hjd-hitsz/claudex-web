import { once } from "node:events";
import { createAgyStore } from "../../server/src/backends/agy/session-store.mjs";
import { createAgyNativeHistoryActions } from "../../server/src/backends/agy/tmp_function/native-history-actions.mjs";

const [directory, stateDirectory, method, point] = process.argv.slice(2);
const store = createAgyStore(stateDirectory);
const history = createAgyNativeHistoryActions({
  directory,
  store: {
    ...store,
    async change(change) {
      // Native files and the SQLite transaction are already applied when
      // the action calls change. Wait here for the parent to kill the process.
      if (point === "after-save") await store.change(change);
      const disconnected = once(process, "disconnect");
      process.send({ point });
      await disconnected;
      throw new Error("测试父进程在结束子进程前断开连接");
    },
  },
  sessions: {
    rewriting: new Set(),
    agentInfo: () => ({ name: "Antigravity ACP Server", version: "1.5.18" }),
    closeForHistory: async () => {},
  },
  occupancy: () => ({}),
  readExecutorBackground: async () => ({ terminals: [], jobs: [] }),
  changed() {
    throw new Error("测试子进程意外完成历史操作");
  },
});
const data = await store.read();
await history.apply(method, data.sessions.web, {}, data);
