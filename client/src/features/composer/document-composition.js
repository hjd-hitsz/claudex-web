export function isCompositionKey(event) {
  return event?.isComposing || event?.keyCode === 229;
}

export function isCompositionInput(event) {
  return event.inputType === "insertCompositionText" || event.isComposing;
}

const caretMovementKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function isCaretMovementKey(key) {
  return caretMovementKeys.has(key);
}

export function protectCompositionKey(event, composing) {
  if (!composing && !isCompositionKey(event.nativeEvent)) return false;
  // These default actions move the caret or close the dialog without beforeinput.
  if (isCaretMovementKey(event.key) || event.key === "Escape")
    event.preventDefault();
  // Confirmation can dispatch a marked key after compositionend.
  if (!composing && ["Enter", "Backspace", "Delete"].includes(event.key))
    event.preventDefault();
  event.stopPropagation?.();
  return true;
}

export function protectCompositionInput(event, composing) {
  if (!composing && !event.isComposing) return;
  // The IME edits its own text via insertCompositionText.
  if (
    [
      "insertParagraph",
      "insertLineBreak",
      "deleteContentBackward",
      "deleteContentForward",
    ].includes(event.inputType)
  )
    event.preventDefault();
}
