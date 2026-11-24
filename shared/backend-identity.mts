// 默认 Codex 实例沿用历史键，其他实例使用带版本前缀的可逆标识。
type NativeId = string | number | null | undefined;

export function resourceId(backendId: string, nativeId: NativeId) {
  if (nativeId == null || nativeId === "") return nativeId;
  if (backendId === "codex") return nativeId;
  return `backend:${encodeURIComponent(backendId)}:${encodeURIComponent(String(nativeId))}`;
}

export function resourceTarget(
  id: string,
  fallback?: string,
): { backendId: string; nativeId: string };
export function resourceTarget(
  id: NativeId,
  fallback?: string,
): { backendId: string; nativeId: NativeId };
export function resourceTarget(id: NativeId, fallback = "codex") {
  if (typeof id !== "string" || !id.startsWith("backend:"))
    return { backendId: fallback, nativeId: id };
  const match = /^backend:([^:]+):(.+)$/.exec(id);
  if (!match) throw new Error("资源标识无效");
  return {
    backendId: decodeURIComponent(match[1]),
    nativeId: decodeURIComponent(match[2]),
  };
}
