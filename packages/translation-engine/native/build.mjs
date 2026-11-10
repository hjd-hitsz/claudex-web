import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "linux" || process.arch !== "x64") {
  console.log("本地翻译引擎的原生分词器构建适用于 Linux x64");
  process.exit(0);
}
const source = fileURLToPath(new URL("./tokenizer.c", import.meta.url));
const output = fileURLToPath(
  new URL("../bin/tokenizer-linux-x64", import.meta.url),
);
execFileSync(
  process.env.CC || "cc",
  ["-O2", "-Wall", "-Wextra", source, "-ldl", "-o", output],
  { stdio: "inherit" },
);
