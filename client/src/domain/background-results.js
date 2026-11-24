export function isBackgroundCompletion(item) {
  return (
    item.type === "functionCallOutput" && item.name === "background_completed"
  );
}

export function isBackgroundCheck(item) {
  return (
    item.type === "functionCallOutput" && item.name === "background_check_due"
  );
}

export function isBackgroundNotice(item) {
  return isBackgroundCompletion(item) || isBackgroundCheck(item);
}

function noticePayload(item) {
  try {
    const output =
      typeof item.output === "string"
        ? item.output
        : item.output?.map((part) => part.text).join("");
    return JSON.parse(output);
  } catch {
    return null;
  }
}

export function backgroundNoticeResults(item) {
  if (!isBackgroundNotice(item)) return [];
  const results = noticePayload(item)?.results;
  return Array.isArray(results)
    ? results.filter((result) => result?.job_id)
    : [];
}

export const backgroundCheckKey = (id) => "check:" + id;

export function backgroundNoticeKeys(item) {
  if (isBackgroundCheck(item)) {
    const id = noticePayload(item)?.notification_id;
    return id ? [backgroundCheckKey(id)] : [];
  }
  return backgroundNoticeResults(item).map((result) => result.job_id);
}
