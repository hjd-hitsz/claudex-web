import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
export const modelId = "edge-en-zh";
export const components = {
  model: "jlkoiilgoccnckeddpanmoamiopnegnn",
  tokenizer: "oiidchjihdkkgdjmohdkalnimpcedjmb",
};
export async function resolveComponents(signal, request = fetch) {
  const version = "154.0.4258.48";
  const cpu = await readFile("/proc/cpuinfo", "utf8");
  const flags = cpu.match(/^flags\s*:\s*(.+)$/m)?.[1].split(/\s+/) || [];
  const hw = Object.fromEntries(
    ["avx", "sse", "sse2", "sse3", "sse41", "sse42", "ssse3"].map((flag) => [
      flag,
      Number(flags.includes(flag.replace(/(sse)(\d)(\d)/, "$1$2_$3"))),
    ]),
  );
  hw.physmemory = Math.round(totalmem() / 1024 ** 3);
  const body = JSON.stringify({
    request: {
      "@os": "linux",
      "@updater": "msedge",
      acceptformat: "crx3,download,run,xz,zucc",
      apps: Object.values(components).map((appid) => ({
        appid,
        lang: "zh-CN",
        installdate: -1,
        ping: { r: -2 },
        enabled: true,
        installsource: "ondemand",
        version: "0.0.0.0",
        updatecheck: {},
        targetingattributes: {
          AppMajorVersion: "154",
          AppVersion: version,
          IsInternalUser: false,
          Priority: true,
        },
      })),
      arch: "x64",
      dedup: "cr",
      hw,
      ismachine: 0,
      os: { arch: "x86_64", platform: "Linux", version: "6.8" },
      prodversion: version,
      protocol: "4.0",
      requestid: `{${randomUUID()}}`,
      sessionid: `{${randomUUID()}}`,
      updaterversion: version,
    },
  });
  const query = new URLSearchParams({
    cup2key: `7:${randomBytes(32).toString("base64url")}`,
    cup2hreq: createHash("sha256").update(body).digest("hex"),
  });
  const response = await request(
    `https://edge.microsoft.com/componentupdater/api/v1/update?${query}`,
    {
      method: "POST",
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: {
        "Content-Type": "application/json",
        "X-Microsoft-Update-AppId": Object.values(components).join(","),
        "X-Microsoft-Update-Interactivity": "fg",
        "X-Microsoft-Update-Updater": `msedge-${version}`,
        "Sec-Mesh-Client-Edge-Version": version,
        "Sec-Mesh-Client-Edge-Channel": "stable",
        "Sec-Mesh-Client-OS": "Linux",
        "Sec-Mesh-Client-Arch": "x86_64",
      },
    },
  );
  if (!response.ok) throw new Error(`模型目录读取失败 (${response.status})`);
  const data = JSON.parse((await response.text()).replace(/^\)\]\}'\s*/, ""));
  return Object.fromEntries(
    Object.entries(components).map(([kind, id]) => {
      const update = data.response.apps.find(
        (app) => app.appid === id,
      )?.updatecheck;
      const operation = update?.pipelines
        ?.flatMap((p) => p.operations)
        .find((op) => op.type === "download");
      if (!operation || !/^\d+(\.\d+){3}$/.test(update.nextversion))
        throw new Error("模型下载目录未提供有效版本，请稍后重试");
      const url = new URL(operation.urls[0].url);
      if (!url.hostname.endsWith(".microsoft.com"))
        throw new Error("模型下载来源无效");
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("模型下载协议无效");
      return [
        kind,
        {
          version: update.nextversion,
          url: url.href,
          size: operation.size,
          sha256: operation.out.sha256,
        },
      ];
    }),
  );
}
