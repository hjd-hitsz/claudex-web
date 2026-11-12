import { Console } from "node:console";

// Node.js 分别读取 stderr 文本日志与 stdout 二进制测试事件。
globalThis.console = new Console({
  stdout: process.stderr,
  stderr: process.stderr,
});
