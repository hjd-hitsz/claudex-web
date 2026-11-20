export function isBackgroundCompletion(item) {
  return (
    item.type === "functionCallOutput" && item.name === "background_completed"
  );
}

export function backgroundCompletionResults(item) {
  if (!isBackgroundCompletion(item)) return [];
  try {
    const output =
      typeof item.output === "string"
        ? item.output
        : item.output?.map((part) => part.text).join("");
    const results = JSON.parse(output)?.results;
    return Array.isArray(results)
      ? results.filter((result) => result?.job_id)
      : [];
  } catch {
    return [];
  }
}

export function backgroundCompletionJobs(item) {
  return backgroundCompletionResults(item).map((result) => result.job_id);
}
