import { isP2pPage, p2pDownloadFrame, p2pFrameUrl } from "./p2p-access.js";

// Claude Code's native read_file control caps complete files at 10,000,000 bytes.
const nativeReadBytes = 10_000_000;

export function workspaceDownloadProps(path, filename) {
  const href = "/api/files?" + new URLSearchParams({ path, download: "1" });
  return isP2pPage()
    ? { href: p2pFrameUrl(href), target: p2pDownloadFrame }
    : { href, download: filename };
}

export async function readWorkspaceFile({
  path,
  backendId,
  cwd,
  providerId,
  threadId,
  rpc,
  request = globalThis.fetch,
}) {
  if (backendId === "claude") {
    const url = "/api/files?" + new URLSearchParams({ path });
    const metadata = await request(url, {
      method: "HEAD",
      credentials: "same-origin",
    });
    if (!metadata.ok)
      throw new Error(`文件读取失败（HTTP ${metadata.status}）`);
    const length = metadata.headers.get("Content-Length");
    const size = length === null ? NaN : Number(length);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("文件长度信息无效");
    if (size > nativeReadBytes) {
      const response = await request(url, { credentials: "same-origin" });
      if (!response.ok)
        throw new Error(`文件读取失败（HTTP ${response.status}）`);
      return new Uint8Array(await response.arrayBuffer());
    }
  }
  const { dataBase64 } = await rpc("fs/readFile", {
    path,
    ...(backendId === "claude" && {
      cwd,
      providerId,
      ...(threadId && { threadId }),
    }),
  });
  return Uint8Array.from(atob(dataBase64), (character) =>
    character.charCodeAt(0),
  );
}
