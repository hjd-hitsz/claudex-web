import {
  enrichSessionMessages,
  readNativeGoalStatus,
  readSessionTranscript,
} from "./native-records.mjs";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { projectSecretaryHistory } from "./secretary-history.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const { operation, args } = JSON.parse(input);
  if (
    ![
      "listSessions",
      "getSessionMessages",
      "forkSession",
      "renameSession",
      "deleteSession",
      "getSubagentMessages",
      "listSubagents",
      "getNativeGoalStatus",
      "projectSecretaryHistory",
    ].includes(operation)
  )
    throw new Error("未知会话操作");
  let result;
  if (operation === "projectSecretaryHistory")
    result = await projectSecretaryHistory(...args);
  else if (operation === "getNativeGoalStatus")
    result = await readNativeGoalStatus(...args);
  else if (
    operation === "getSessionMessages" &&
    args[1]?.includeCompactedHistory
  ) {
    const { includeCompactedHistory, ...options } = args[1];
    result = await readSessionTranscript(args[0], options);
  } else {
    result = await sdk[operation](...args);
    if (["getSessionMessages", "getSubagentMessages"].includes(operation))
      result = await enrichSessionMessages(operation, args, result);
  }
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
}
