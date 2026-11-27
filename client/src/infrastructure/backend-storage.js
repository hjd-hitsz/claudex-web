export const newDraftKey = "cx-draft-new";

const legacyDraftKeys = ["cx-draft-new-claude", "cx-draft-new-agy"];

export function readNewDraft() {
  const draft = localStorage.getItem(newDraftKey) || "";
  const legacyDrafts = legacyDraftKeys.map((key) => localStorage.getItem(key));
  if (legacyDrafts.every((text) => text === null)) return draft;

  // 分段保留各后端的旧文本，重试时跳过已经写入的段落。
  const combined = legacyDrafts.reduce((text, legacy) => {
    if (!legacy || `\n\n${text}\n\n`.includes(`\n\n${legacy}\n\n`)) return text;
    return text ? `${text}\n\n${legacy}` : legacy;
  }, draft);
  localStorage.setItem(newDraftKey, combined);
  for (const key of legacyDraftKeys) localStorage.removeItem(key);
  return combined;
}
