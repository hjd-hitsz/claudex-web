import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { applyWorkspaceToolGuidance } from "./workspace-tool-guidance.mjs";
import {
  formatReadRange,
  readDescription,
  readInput,
  readRanges,
} from "../../workspace/tools/ranges.mjs";
import {
  findInput,
  grepInput,
  searchSummary,
} from "../../workspace/tools/evidence.mjs";
import { fetchPageEvidence } from "./webfetch.mjs";
import { searchWeb } from "./web-search.mjs";

const namespace = "claudex";
const definitions = {
  read: {
    description: readDescription,
    schema: readInput,
    readOnlyHint: true,
  },
  patch: {
    replaces: ["edit", "write"],
    permission: "edit",
    description:
      "Create, update, move, or delete files in a single patch. Use *** Begin Patch, *** Add File / *** Update File / *** Delete File sections and *** End Patch. Existing file sections use @@ and prefixed context, removal, and addition lines.",
    schema: z.strictObject({ patchText: z.string().min(1) }),
  },
  grep: {
    description:
      "Search workspace files. Default mode returns matching paths. Use count for counts or content for matching lines. Large searches can be narrowed with path, include, or limit.",
    schema: grepInput,
    readOnlyHint: true,
  },
  webfetch: {
    description:
      "Open an HTTP or HTTPS page for a short preview and links, or supply terms to find excerpts on the page. If the terms miss the body, use the preview or matching links to continue. Use startLine to continue reading.",
    schema: findInput,
    readOnlyHint: true,
  },
  web_search: {
    original: "websearch",
    permission: "websearch",
    description:
      "Search the web for relevant sources and return concise evidence and URLs. Use claudex_webfetch to read a specific URL.",
    schema: z.strictObject({ query: z.string().trim().min(1) }),
    readOnlyHint: true,
  },
  skill: {
    description:
      "Load the instructions and resource list for one or more skills. Supply the available skill IDs in workflow order. Load all known prerequisites in one call. A skill already present in the conversation does not need to be loaded again.",
    schema: z.strictObject({ ids: z.array(z.string().min(1)).min(1) }),
    readOnlyHint: true,
  },
  shell: {
    schema: z.strictObject({
      command: z.string(),
      workdir: z.string().optional(),
      timeout: z.int().nonnegative().optional(),
      background: z.boolean().optional(),
    }),
  },
};

async function run(
  name,
  definition,
  ctx,
  original,
  value,
  context,
  hostedSearch,
) {
  const args = definition.schema.parse(value);
  const execute = (input) => original.execute(input, context);
  if (name === "read") {
    const rows = await readRanges(
      ctx.location.directory,
      args,
      async ({ path, start, end }) => {
        const result = await execute({
          path,
          offset: start,
          ...(Number.isFinite(end) && { limit: end - start + 1 }),
        });
        const { output } = result;
        if (output.type !== "text") return result;
        return {
          text: formatReadRange(
            path,
            output.offset,
            output.content.split("\n").slice(0, output.lineCount),
            output.next !== undefined && output.next <= end
              ? `Continue at line ${output.next}.`
              : undefined,
          ),
        };
      },
      context.signal,
    );
    return {
      content: rows.flatMap(({ text, content }) => parts(text ?? content)),
    };
  }
  if (name === "skill") {
    const results = [];
    for (const id of new Set(args.ids)) {
      context.signal.throwIfAborted();
      try {
        results.push(await execute({ id }));
      } catch (error) {
        context.signal.throwIfAborted();
        results.push({ error, content: `${id}: ${error.message}` });
      }
    }
    if (results.every((result) => result.error)) throw results[0].error;
    return { content: results.flatMap(({ content }) => parts(content)) };
  }
  if (name === "grep") {
    const {
      mode = "files",
      limit = mode === "content" ? 30 : 500,
      ...query
    } = args;
    return { content: searchSummary(await execute({ ...query, limit }), mode) };
  }
  if (name === "webfetch")
    return {
      content: await fetchPageEvidence(
        args,
        execute,
        context,
        ctx.permission.assert,
      ),
    };
  if (name === "web_search")
    return searchWeb({ ctx, query: args.query, context, hostedSearch });
  return execute(args);
}

function parts(content) {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function toMcpContent(content) {
  return parts(content).map((part) => {
    if (part.type !== "file") return part;
    return {
      type: "resource",
      resource: {
        uri: `claudex://read/${encodeURIComponent(part.name ?? "file")}`,
        mimeType: part.mime,
        blob: part.uri.slice(part.uri.indexOf(",") + 1),
        _meta: { name: part.name },
      },
    };
  });
}

function toNativeContent(content) {
  return content.map((part) => {
    if (part.type !== "resource") return part;
    const { blob, mimeType, _meta } = part.resource;
    return {
      type: "file",
      uri: `data:${mimeType};base64,${blob}`,
      mime: mimeType,
      name: _meta?.name,
    };
  });
}

export async function startWorkspaceTools({ hostedSearch } = {}) {
  const invocations = new Map();
  const server = new Server(
    { name: namespace, version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(definitions).map(([name, definition]) => ({
      name,
      description: definition.description,
      inputSchema: z.toJSONSchema(definition.schema),
      annotations: { readOnlyHint: definition.readOnlyHint === true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const { invocation, ...input } = params.arguments ?? {};
    const call = invocations.get(invocation);
    if (call?.name !== params.name)
      throw new Error("Missing Claudex tool invocation.");
    try {
      const result = await call.execute(input);
      call.metadata = result.metadata;
      call.output = result.output;
      return { content: toMcpContent(result.content ?? result.output) };
    } catch (error) {
      call.failure = error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  });
  const client = new Client({ name: namespace, version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return {
    plugin: {
      id: "claudex.workspace-tools",
      async setup(ctx) {
        await ctx.tool.transform((editor) => {
          for (const { name, inputSchema, description } of tools) {
            const definition = definitions[name];
            const original = editor.get(definition.original ?? name);
            if (!original) continue;
            editor.add({
              name: `${namespace}_${name}`,
              description: description ?? original.description,
              input: inputSchema,
              output: name === "shell" ? original.output : undefined,
              options: {
                codemode: false,
                permission: definition.permission ?? name,
              },
              async execute(input, context) {
                const invocation = randomUUID();
                const call = {
                  name,
                  execute: (args) =>
                    run(
                      name,
                      definition,
                      ctx,
                      original,
                      args,
                      context,
                      hostedSearch,
                    ),
                };
                invocations.set(invocation, call);
                try {
                  const response = await client.callTool(
                    { name, arguments: { ...input, invocation } },
                    undefined,
                    // Let the native tool own the operation deadline. This is Node's maximum timer.
                    { signal: context.signal, timeout: 2_147_483_647 },
                  );
                  if (call.failure) throw call.failure;
                  return {
                    content: toNativeContent(response.content),
                    ...(name === "shell" && { output: call.output }),
                    ...(call.metadata && { metadata: call.metadata }),
                  };
                } finally {
                  invocations.delete(invocation);
                }
              },
            });
            editor.remove(original.name);
            for (const replaced of definition.replaces ?? [])
              editor.remove(replaced);
          }
        });
        const guide = (request) =>
          applyWorkspaceToolGuidance(
            request,
            async (agentID) => (await ctx.agent.get({ agentID })).data,
          );
        for (const hook of ["context", "generate", "compaction"])
          await ctx.session.hook(hook, guide);
      },
    },
    close: () => client.close(),
  };
}
