import type { Socket } from "node:net";

const MAX_IPC_BYTES = 128 * 1024 * 1024;

export function readWorkerLines(
  socket: Socket,
  limitError: string,
  receive: (line: string) => void,
) {
  let parts: string[] = [];
  let bytes = 0;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const part = end < 0 ? chunk.slice(start) : chunk.slice(start, end);
      bytes += Buffer.byteLength(part);
      if (bytes > MAX_IPC_BYTES) {
        parts = [];
        socket.destroy(new Error(limitError));
        return;
      }
      if (part) parts.push(part);
      if (end < 0) return;
      const line = parts.join("");
      parts = [];
      bytes = 0;
      start = end + 1;
      receive(line);
    }
  });
}
