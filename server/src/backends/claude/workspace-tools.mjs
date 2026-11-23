import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  formatReadRange,
  readInput,
  readRanges,
} from "../../workspace/tools/ranges.mjs";

export function workspaceToolsForClaude({ cwd, readFile }) {
  return {
    claudex: createSdkMcpServer({
      name: "claudex",
      tools: [
        tool(
          "read",
          "Read one or more text files. Batch related paths in one call. Adjacent and overlapping lines are combined. Omit start and end to read from the beginning. Use Read for images, PDFs, and directories.",
          readInput.shape,
          async (args) => {
            const files = new Map();
            try {
              const rows = await readRanges(
                cwd,
                args,
                async ({ path, start, end }) => {
                  if (!files.has(path))
                    files.set(
                      path,
                      await readFile(path, { maxBytes: 1024 * 1024 }),
                    );
                  const result = files.get(path);
                  if (
                    !result ||
                    result.lossy ||
                    result.contents.includes("\0")
                  ) {
                    throw new Error(
                      "Text is unavailable. Check the path, file type, and native read permissions.",
                    );
                  }
                  const lines = result.contents.split(/\r?\n/);
                  if (result.truncated || lines.at(-1) === "") lines.pop();
                  return {
                    text: formatReadRange(
                      path,
                      start,
                      lines.slice(start - 1, end),
                      result.truncated && end > lines.length
                        ? "Range extends beyond the read limit. Use Read with an offset."
                        : undefined,
                    ),
                  };
                },
              );
              return {
                content: rows.map(({ text }) => ({ type: "text", text })),
              };
            } catch (error) {
              return {
                isError: true,
                content: [{ type: "text", text: error.message }],
              };
            }
          },
          { annotations: { readOnlyHint: true }, alwaysLoad: true },
        ),
      ],
    }),
  };
}
