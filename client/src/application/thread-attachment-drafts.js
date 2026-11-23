export function createThreadAttachmentDrafts(get, set) {
  const drafts = new Map();

  function getAttachmentDraft(id = get().current?.id ?? null) {
    if (!drafts.has(id)) drafts.set(id, { attachments: [] });
    const draft = drafts.get(id);
    if (id === (get().current?.id ?? null))
      draft.attachments = get().attachments;
    return draft;
  }

  function updateAttachmentDraft(draft, update) {
    const current = getAttachmentDraft();
    draft.attachments = update(draft.attachments);
    if (current === draft) set({ attachments: draft.attachments });
  }

  function assignNewThread(id) {
    drafts.set(id, getAttachmentDraft());
    drafts.delete(null);
  }

  return { getAttachmentDraft, updateAttachmentDraft, assignNewThread };
}
