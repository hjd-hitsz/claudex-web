import { writePrivateFile } from "../../private-file.mjs";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) throw new Error("agy 状态栏消息过大");
}
const { quota, plan_tier: plan } = JSON.parse(input);
if (quota && Object.keys(quota).length)
  await writePrivateFile(process.argv[2], JSON.stringify({ quota, plan }));
