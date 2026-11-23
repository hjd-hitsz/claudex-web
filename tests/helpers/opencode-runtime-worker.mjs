import { createOpenCodeWorkerAdapter } from "../../server/src/backends/opencode/worker-client.mjs";
process.once("message", async ({ backend, config, cwd, model }) => {
  try {
    const adapter = createOpenCodeWorkerAdapter({
      backend,
      config,
      broadcast: (event) => process.send?.(event),
      send: (client, message) => client.deliver(message),
    });
    let sequence = 0;
    const call = (method, params) =>
      new Promise((resolve, reject) =>
        adapter.receive(
          {
            deliver(message) {
              if (message.error) reject(new Error(message.error.message));
              else resolve(message.result);
            },
          },
          { id: ++sequence, method, params },
        ),
      );
    await adapter.connect();
    const { thread } = await call("thread/start", { cwd, model });
    process.send?.({
      control: "connected",
      pid: adapter.workerPid,
      threadId: thread.id,
    });
    await call("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "启动后台生命周期隔离验证" }],
    });
  } catch (error) {
    process.send?.({ control: "error", message: error.message });
  }
});
