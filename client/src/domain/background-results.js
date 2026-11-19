export function backgroundCompletionJobs(item) {
  if (
    item.type !== "functionCallOutput" ||
    item.name !== "background_completed"
  )
    return [];
  try {
    const output =
      typeof item.output === "string"
        ? item.output
        : item.output?.map((part) => part.text).join("");
    return (JSON.parse(output)?.results || []).map((result) => result.job_id);
  } catch {
    return [];
  }
}
