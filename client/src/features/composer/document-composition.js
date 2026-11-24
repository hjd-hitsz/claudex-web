export function isCompositionKey(event) {
  return event.isComposing || event.keyCode === 229;
}

export const documentCompositionEvents = {
  keydown(view, event) {
    if (view.composing) return true;
    if (!isCompositionKey(event)) return false;
    // A confirmation key can arrive after the composition has already ended.
    if (["Enter", "Backspace", "Delete"].includes(event.key))
      event.preventDefault();
    return true;
  },
  beforeinput(view, event) {
    if (!view.composing && !event.isComposing) return false;
    // Chromium can emit ordinary editing actions during composition.
    // Composition text updates keep their own input type and native handling.
    if (
      [
        "insertParagraph",
        "insertLineBreak",
        "deleteContentBackward",
        "deleteContentForward",
      ].includes(event.inputType)
    )
      event.preventDefault();
    return event.defaultPrevented;
  },
};
