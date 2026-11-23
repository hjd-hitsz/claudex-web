async function completedResponse(response) {
  const stream = response.body.pipeThrough(new TextDecoderStream());
  const items = [];
  let pending = "";
  for await (const chunk of stream) {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const event = JSON.parse(payload);
      if (event.type === "response.output_item.done")
        items[event.output_index] = event.item;
      if (event.type === "response.completed")
        return event.response.output?.length
          ? event.response.output
          : items.filter(Boolean);
      if (
        ["error", "response.failed", "response.incomplete"].includes(event.type)
      )
        throw new Error("OpenAI web search did not complete.");
    }
  }
  throw new Error("OpenAI web search ended without a response.");
}

export async function searchCodexWeb({
  url,
  headers,
  model,
  query,
  signal,
  fetch,
}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
      instructions:
        "Use web search to find direct evidence for the query. Return a short answer and cite the relevant source URLs. Do not perform any other task.",
      tools: [
        {
          type: "web_search",
          external_web_access: true,
          search_context_size: "low",
        },
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
      store: false,
      stream: true,
    }),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      `OpenAI web search request failed (HTTP ${response.status}).`,
    );
  }
  const output = await completedResponse(response);
  if (
    !output.some(
      (item) => item.type === "web_search_call" && item.status === "completed",
    )
  )
    throw new Error("OpenAI did not return a completed web search.");
  const parts = output.flatMap((item) =>
    item.type === "message"
      ? (item.content ?? []).filter((part) => part.type === "output_text")
      : [],
  );
  const links = new Map();
  for (const part of parts)
    for (const note of part.annotations ?? [])
      if (note.type === "url_citation" && /^https?:\/\//i.test(note.url))
        links.set(note.url, note.title || note.url);
  const sources = [...links]
    .slice(0, 8)
    .map(([url, title]) => `${title}\n${url}`);
  const answer = parts
    .map(({ text }) => text)
    .join("\n")
    .trim()
    .slice(0, 2400);
  return {
    content:
      [answer, ...sources].filter(Boolean).join("\n\n") ||
      "No search results found.",
    metadata: { provider: "openai" },
  };
}
