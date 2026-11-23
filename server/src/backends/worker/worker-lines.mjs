const MAX_IPC_BYTES = 128 * 1024 * 1024;

export function readWorkerLines(socket, limitError, receive) {
  let input = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_IPC_BYTES)
      return socket.destroy(new Error(limitError));
    let index;
    while ((index = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, index);
      input = input.slice(index + 1);
      receive(line);
    }
  });
}
