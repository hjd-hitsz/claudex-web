export async function searchWeb({ ctx, query, context, hostedSearch }) {
  const { sessionID, agent, messageID, id, signal } = context;
  await ctx.permission.assert({
    sessionID,
    agent,
    action: "websearch",
    resources: [query],
    save: ["*"],
    metadata: { query },
    source: { type: "tool", messageID, id },
  });
  signal.throwIfAborted();
  const hosted = await hostedSearch?.({ query, sessionID, messageID, signal });
  if (hosted) return hosted;

  const input = { location: ctx.location, query };
  const { data } = await ctx.websearch.query(input).catch((error) => {
    if (error._tag !== "WebSearch.ProviderRequired") throw error;
    signal.throwIfAborted();
    return ctx.websearch.query({ ...input, providerID: "exa" });
  });
  signal.throwIfAborted();
  const content = data.results
    .filter(({ url }) => /^https?:\/\//i.test(url))
    .slice(0, 8)
    .map(({ url, title, content }) =>
      [title || url, url, content?.slice(0, 480)].filter(Boolean).join("\n"),
    )
    .join("\n\n");
  return {
    content: content || "No search results found.",
    metadata: { provider: data.providerID },
  };
}
