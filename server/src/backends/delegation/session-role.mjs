export function isSecretarySession(backendId, delegationMode, turn = {}) {
  return (
    !turn.delegation &&
    !turn.review &&
    (backendId === "agy" || delegationMode === true)
  );
}
