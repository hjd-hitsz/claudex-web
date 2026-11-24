import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function backgroundWorkerClock(directory) {
  const location = join(directory, "background-clock");
  const preload = join(directory, "background-clock.mjs");
  let offset = 0;
  await writeFile(location, String(offset));
  await writeFile(
    preload,
    `import { readFileSync } from "node:fs";
if (process.argv[1]?.endsWith("/packages/background-terminal/cli.mjs") && process.argv[2] === "serve") {
  const wallClock = Date.now;
  Date.now = () => wallClock() + Number(readFileSync(${JSON.stringify(location)}, "utf8"));
}
`,
  );
  return {
    nodeOptions: [
      process.env.NODE_OPTIONS,
      "--import=" + pathToFileURL(preload),
    ]
      .filter(Boolean)
      .join(" "),
    async advance(ms) {
      offset += ms;
      await writeFile(location + ".tmp", String(offset));
      await rename(location + ".tmp", location);
    },
  };
}
