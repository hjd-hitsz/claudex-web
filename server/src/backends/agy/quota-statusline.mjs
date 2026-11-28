import { writePrivateFile } from "../../private-file.mjs";

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) throw new Error("agy 状态栏消息过大");
  chunks.push(chunk);
}
const { quota, plan_tier: plan } = JSON.parse(
  Buffer.concat(chunks, bytes).toString("utf8"),
);
if (quota && Object.keys(quota).length)
  await writePrivateFile(process.argv[2], JSON.stringify({ quota, plan }));
