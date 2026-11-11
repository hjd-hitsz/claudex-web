export function cliUpdateAvailable(currentVersion, latestVersion) {
  const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/;
  const current = pattern.exec(currentVersion || "");
  const latest = pattern.exec(latestVersion || "");
  if (!current || !latest) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(latest[index]) - Number(current[index]);
    if (difference) return difference > 0;
  }
  if (!current[4] || !latest[4]) return Boolean(current[4] && !latest[4]);
  const installed = current[4].split(".");
  const available = latest[4].split(".");
  for (
    let index = 0;
    index < Math.max(installed.length, available.length);
    index++
  ) {
    const left = installed[index];
    const right = available[index];
    if (left === right) continue;
    if (left === undefined) return true;
    if (right === undefined) return false;
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) return Number(right) > Number(left);
    if (leftNumber !== rightNumber) return leftNumber;
    return right > left;
  }
  return false;
}
