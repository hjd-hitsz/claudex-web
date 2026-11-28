import { isDeepStrictEqual } from "node:util";

const fields = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];

function usageCounts(value) {
  return Object.fromEntries(
    fields
      .filter(
        (field) => Number.isSafeInteger(value?.[field]) && value[field] >= 0,
      )
      .map((field) => [field, value[field]]),
  );
}

export function mergeClaudeUsage(previous, usage, cumulative = false) {
  const counts = usageCounts(usage);
  if (!cumulative)
    for (const field of Object.keys(counts))
      counts[field] = Math.max(
        previous?.[field] ?? counts[field],
        counts[field],
      );
  return { ...previous, ...counts };
}

function sumUsage(values) {
  const usage = {};
  for (const value of values)
    for (const [key, count] of Object.entries(value))
      usage[key] = (usage[key] ?? 0) + count;
  return usage;
}

function breakdown(counts) {
  const {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  } = counts;
  return {
    ...(input != null && { inputTokens: input }),
    ...(output != null && { outputTokens: output }),
    ...((read != null || write != null) && {
      cachedInputTokens: (read ?? 0) + (write ?? 0),
    }),
    ...(Object.keys(counts).length > 0 && {
      totalTokens: Object.values(counts).reduce((sum, count) => sum + count, 0),
    }),
  };
}

export function historicalClaudeUsage(messages) {
  return {
    round: breakdown(sumUsage(messages.values())),
    last: breakdown([...messages.values()].at(-1)),
  };
}

function totals(models = {}) {
  return breakdown(
    sumUsage(
      Object.values(models).map((model) =>
        usageCounts({
          input_tokens: model.inputTokens,
          output_tokens: model.outputTokens,
          cache_read_input_tokens: model.cacheReadInputTokens,
          cache_creation_input_tokens: model.cacheCreationInputTokens,
        }),
      ),
    ),
  );
}

export function configuredTokenUsage(session, provider) {
  const contextWindow =
    provider?.modelCapabilities?.[session.model]?.contextWindow;
  return session.tokenUsage && contextWindow
    ? {
        ...session.tokenUsage,
        model: session.model,
        modelContextWindow: contextWindow,
      }
    : session.tokenUsage;
}
export function createTokenUsage({ threadId, session, save, emit }) {
  let value = session.tokenUsage || null;
  let capacityQuery, capacityModel, turnId, streamingId;
  let capacityStale = false;
  const messages = new Map();
  async function publish(next, turn) {
    value = next;
    if (turn) turn.tokenUsage = next;
    await save(threadId, (s) => ({
      ...s,
      tokenUsage: next,
      ...(turn && { turns: { ...s.turns, [turn.id]: turn } }),
    }));
    emit("thread/tokenUsage/updated", { threadId, tokenUsage: next });
  }
  return async (message, process, turn) => {
    if (message.parent_tool_use_id || message.isReplay) return;
    const capacityChanged =
      capacityQuery !== process.query || capacityModel !== process.model;
    if (capacityChanged) {
      capacityQuery = process.query;
      capacityModel = process.model;
      capacityStale = true;
    }
    if (capacityChanged || turnId !== turn?.id) {
      messages.clear();
      streamingId = undefined;
      turnId = turn?.id;
    }
    const event = message.type === "stream_event" ? message.event : undefined;
    if (event?.type === "message_start") streamingId = event.message.id ?? null;
    const apiMessage =
      message.type === "assistant" ? message.message : event?.message;
    const delta = event?.type === "message_delta" && streamingId !== undefined;
    const usage = delta ? event.usage : apiMessage?.usage;
    const id = delta ? streamingId : (apiMessage?.id ?? null);
    if (usage) {
      const counts = mergeClaudeUsage(messages.get(id), usage, delta);
      if (Object.keys(counts).length) {
        messages.set(id, counts);
        // Assistant content blocks can arrive after the next message starts.
        const pendingMeasurement =
          !delta && fields.every((field) => counts[field] === 0);
        if (!pendingMeasurement && (!streamingId || id === streamingId)) {
          const last = breakdown(counts);
          if (
            capacityStale ||
            value?.turnId !== turnId ||
            !isDeepStrictEqual(value?.last, last)
          ) {
            const next = {
              ...(value?.turnId === turnId
                ? value
                : { modelContextWindow: value?.modelContextWindow }),
              turnId,
              model: process.model,
              last,
            };
            if (capacityStale) {
              delete next.modelContextWindow;
              capacityStale = false;
            }
            if (!next.modelContextWindow) await context(next, process);
            await publish(next);
          }
        }
      }
    }
    if (message.type !== "result") return;
    const model = message.modelUsage?.[process.model];
    const next = {
      ...(value?.turnId === turnId ? value : { last: value?.last }),
      turnId,
      total: totals(message.modelUsage),
      model: process.model,
      modelContextWindow:
        model?.contextWindow ||
        (!capacityStale ? value?.modelContextWindow : undefined),
    };
    const round = breakdown(usageCounts(message.usage));
    const previous = turn?.tokenUsage?.round;
    if (previous || Object.keys(round).length)
      next.round = sumUsage([previous ?? {}, round]);
    messages.clear();
    streamingId = undefined;
    capacityStale = false;
    await context(next, process, true);
    await publish(next, turn);
  };
  async function context(next, process, updateTotal = false) {
    try {
      const context = await process.query.getContextUsage({
        detail: "summary",
      });
      if (updateTotal)
        next.last = { ...next.last, totalTokens: context.totalTokens };
      if (context.rawMaxTokens > 0)
        next.modelContextWindow = context.rawMaxTokens;
      delete next.error;
    } catch (error) {
      next.error = error.message;
    }
  }
}
