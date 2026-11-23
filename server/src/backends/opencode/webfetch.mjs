import { parse } from "parse5";
import { pageEvidence } from "../../workspace/tools/evidence.mjs";

const fetchDeadlineMs = 30_000;
const maxHtmlBytes = 5 * 1024 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const transientCodes = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function transientTransport(error) {
  const reason = error?.error?.reason;
  if (reason?._tag !== "TransportError") return false;
  const { cause } = reason;
  return transientCodes.has(cause?.code ?? cause?.cause?.code);
}

const attr = (node, name) =>
  node.attrs?.find((entry) => entry.name === name)?.value;

function webUrl(href, base) {
  const url = URL.parse(href, base);
  return url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url
    : null;
}

async function readHtml(response) {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("text/html")
  ) {
    await response.body?.cancel();
    return "";
  }
  const decoder = new TextDecoder();
  let size = 0,
    html = "";
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxHtmlBytes) return "";
    html += decoder.decode(chunk, { stream: true });
  }
  return html + decoder.decode();
}

async function htmlNavigation(source, context, assertPermission, remainingMs) {
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(Math.ceil(remainingMs)),
  ]);
  let url = webUrl(source);
  for (let redirects = 0; url && redirects <= 10; redirects++) {
    url.hash = "";
    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: "text/html, application/xhtml+xml" },
        redirect: "manual",
        signal,
      });
      if (!redirectStatuses.has(response.status))
        return { html: await readHtml(response), source: url.href };
      await response.body?.cancel();
    } catch {
      context.signal.throwIfAborted();
      return;
    }
    const location = response.headers.get("location");
    const target = location && webUrl(location, url);
    if (!target || redirects === 10 || signal.aborted) return;
    target.hash = "";
    // The initial URL was approved by the native Markdown request in this call.
    // Check any new redirect target through OpenCode before requesting it.
    await assertPermission({
      sessionID: context.sessionID,
      agent: context.agent,
      action: "webfetch",
      resources: [target.href],
      save: ["*"],
      metadata: { url: target.href, format: "html" },
      source: { type: "tool", messageID: context.messageID, id: context.id },
    });
    url = target;
  }
}

function pageLinks(html, source, terms) {
  const anchors = [];
  let base, canonical;
  const visibleText = (node) => {
    if (attr(node, "aria-hidden") === "true") return "";
    return node.value ?? (node.childNodes ?? []).map(visibleText).join("");
  };
  function visit(node, inNavigation = false) {
    if (["script", "style", "template"].includes(node.tagName)) return;
    if (node.tagName === "base") base ??= attr(node, "href");
    if (node.tagName === "link" && attr(node, "rel") === "canonical")
      canonical ??= attr(node, "href");
    const navigation =
      inNavigation || ["nav", "header", "aside"].includes(node.tagName);
    if (node.tagName === "a") {
      const href = attr(node, "href");
      const text = (visibleText(node).trim() || attr(node, "aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
      if (href && !href.startsWith("#") && text)
        anchors.push({ href, text, navigation });
    }
    for (const child of node.childNodes ?? []) visit(child, navigation);
  }
  visit(parse(html));
  const finalSource = webUrl(canonical ?? source, source) ?? new URL(source);
  const linkBase = webUrl(base ?? finalSource.href, finalSource) ?? finalSource;
  const links = new Map();
  const needles = terms.map((term) => term.toLowerCase());
  for (const { href, text, navigation } of anchors) {
    const url = webUrl(href, linkBase);
    if (
      !url ||
      url.href === finalSource.href ||
      url.href.length > 512 ||
      links.has(url.href)
    )
      continue;
    const label = text.slice(0, 120);
    const haystack = `${label} ${url.pathname}`.toLowerCase();
    links.set(url.href, {
      text: `${label} — ${url.href}`,
      match: needles.some((term) => haystack.includes(term)),
      navigation,
    });
  }
  const entries = [...links.values()];
  const matching = entries.filter(({ match }) => match);
  const nearby = entries.filter(
    ({ match, navigation }) => !match && navigation,
  );
  return [
    ...matching,
    ...nearby,
    ...entries.filter(({ match, navigation }) => !match && !navigation),
  ]
    .slice(0, 8)
    .map(({ text }) => `- ${text}`)
    .join("\n");
}

function preview(page, startLine) {
  const lines = page.split(/\r?\n/);
  const excerpt = lines.slice(startLine - 1, startLine + 22);
  if (!excerpt.length) return "End of page.";
  const prefix = excerpt.join("\n");
  let end = startLine + excerpt.length - 1;
  if (prefix.length > 1800) {
    const fits = prefix.slice(0, 1800);
    end = startLine + fits.split("\n").length - 2;
    // Very long individual lines still show the start of the requested line.
    if (end < startLine)
      return `Line ${startLine} (excerpt)\n${fits.split("\n")[0]}…`;
  }
  return [
    `Preview from lines ${startLine}-${end}`,
    ...lines.slice(startLine - 1, end),
    ...(end < lines.length ? [`[Continue from line ${end + 1}.]`] : []),
  ].join("\n");
}

export async function fetchPageEvidence(
  args,
  execute,
  context,
  assertPermission,
) {
  const deadline = performance.now() + fetchDeadlineMs;
  const remaining = () => deadline - performance.now();
  const fetchMarkdown = () =>
    execute({
      url: args.url,
      format: "markdown",
      timeout: Math.max(0.001, remaining() / 1000),
    });
  const { url, terms = [], startLine = 1 } = args;
  const { output } = await fetchMarkdown().catch((error) => {
    context.signal.throwIfAborted();
    if (!transientTransport(error) || remaining() <= 0) throw error;
    return fetchMarkdown();
  });
  const evidence = terms.length && pageEvidence(output.output, args);
  if (evidence) return evidence;
  let links = "";
  // A negotiated Markdown article can omit the site's navigation entirely.
  const remainingMs = remaining();
  if (startLine === 1 && remainingMs > 0) {
    const navigation = await htmlNavigation(
      url,
      context,
      assertPermission,
      remainingMs,
    );
    if (navigation?.html)
      links = pageLinks(navigation.html, navigation.source, terms);
  }
  return [
    url,
    terms.length
      ? `No matching text in the page body from line ${startLine}.`
      : "",
    preview(output.output, startLine),
    links && `Page links\n${links}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
