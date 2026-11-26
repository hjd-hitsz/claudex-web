const settingsStart = "<USER_SETTINGS_CHANGE>";
const settingsBody = "The user changed setting ";
const settingsEnd = "</USER_SETTINGS_CHANGE>";

export function visibleAcpMessage(text, final = true) {
  while (text) {
    const candidate = text.trimStart();
    if (!final && settingsStart.startsWith(candidate)) return null;
    if (!candidate.startsWith(settingsStart)) return text;
    const body = candidate.slice(settingsStart.length).trimStart();
    if (!final && settingsBody.startsWith(body)) return null;
    if (!body.startsWith(settingsBody)) return text;
    const end = body.indexOf(settingsEnd);
    if (end === -1) return final ? text : null;
    text = body.slice(end + settingsEnd.length).trimStart();
  }
  return "";
}

export function visibleAgyItems(items) {
  return items.flatMap((item) => {
    if (item.type !== "agentMessage" || !item.text) return [item];
    const text = visibleAcpMessage(item.text);
    return text ? [text === item.text ? item : { ...item, text }] : [];
  });
}

export function agyConversationContext(turns) {
  return turns
    .flatMap(({ items }) => visibleAgyItems(items))
    .filter(
      ({ type, origin }) =>
        !origin && ["userMessage", "agentMessage"].includes(type),
    )
    .map(
      ({ type, content, text }) =>
        (type === "userMessage" ? "用户： " : "助手： ") +
        (text ||
          content
            ?.map((part) => part.text || part.path || "[图片]")
            .join("\n")),
    )
    .join("\n\n");
}
