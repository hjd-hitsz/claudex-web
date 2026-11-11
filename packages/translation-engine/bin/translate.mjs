#!/usr/bin/env node
import {
  createTranslationEngine,
  defaultModelDirectory,
} from "../src/index.mjs";
const directory =
  process.env.CLAUDEX_TRANSLATION_MODEL_DIR || defaultModelDirectory();
const [command, ...words] = process.argv.slice(2);
if (
  !["download", "translate"].includes(command) ||
  (command === "translate" && !words.length)
) {
  console.log(
    "用法：claudex-translate download | translate <英文文本>\n模型目录通过 CLAUDEX_TRANSLATION_MODEL_DIR 设置。",
  );
  process.exitCode = 1;
} else {
  const engine = createTranslationEngine({
    directory,
    onProgress: (status) => console.error(JSON.stringify(status)),
  });
  try {
    await engine.prepare();
    if (command === "translate")
      console.log((await engine.translate([words.join(" ")]))[0]);
  } finally {
    await engine.close();
  }
}
