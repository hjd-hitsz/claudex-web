export function composerReferenceFixture(sharedSuggestions = {}) {
  const original = WebSocket.prototype.send;
  const entries = [
    { fileName: "sample.js", isDirectory: false },
    { fileName: "分析.py", isDirectory: false },
    { fileName: "图片.png", isDirectory: false },
    { fileName: "资料", isDirectory: true },
  ];
  WebSocket.prototype.send = function (raw) {
    const request = JSON.parse(raw);
    const { method, params } = request;
    let result;
    if (method === "skills/list")
      result = {
        data: [
          {
            skills: [
              {
                name: "demo-skill",
                path: "/demo/SKILL.md",
                description: "演示技能",
              },
              { name: "native-skill", native: true, description: "原生技能" },
            ],
          },
        ],
      };
    if (method === "fs/readDirectory") result = { entries };
    if (method === "fuzzyFileSearch")
      result = {
        files: entries
          .filter((row) =>
            row.fileName.includes(params.query.split("/").at(-1)),
          )
          .map((row) => ({
            path: params.query.includes("/")
              ? params.query.slice(0, params.query.lastIndexOf("/") + 1) +
                row.fileName
              : row.fileName,
            root: "/demo/history",
            file_name: row.fileName,
            match_type: row.isDirectory ? "directory" : "file",
          })),
      };
    if (method === "fuzzyFileSearch" && params.query === "target")
      result = {
        files: [
          ["target/a.js", "file"],
          ["target/b.js", "file"],
          ["target/fixtures", "directory"],
          ["retarget.js", "file"],
          ["parseTarget.js", "file"],
          ["z/target.js", "file"],
          ["target-assets", "directory"],
          ["target", "directory"],
        ].map(([path, type]) => ({
          root: "/demo/history",
          path,
          file_name: path.split("/").at(-1),
          match_type: type,
        })),
      };
    if (method === "fuzzyFileSearch" && params.query === "src/server")
      result = {
        files: [
          {
            path: "client/src/assets/providers",
            root: "/demo/history",
            file_name: "providers",
            match_type: "directory",
          },
          {
            path: "server/src/server.mjs",
            root: "/demo/history",
            file_name: "server.mjs",
            match_type: "file",
          },
        ],
      };
    if (method === "fuzzyFileSearch" && params.query === "cld/tknusg")
      result = {
        files: [
          {
            path: "server/src/backends/claude/token-usage.mjs",
            root: "/demo/history",
            file_name: "token-usage.mjs",
            match_type: "file",
          },
        ],
      };
    if (
      method === "fuzzyFileSearch" &&
      Object.hasOwn(sharedSuggestions, params.query)
    )
      result = sharedSuggestions[params.query];
    if (method === "turn/start")
      result = { turn: { id: "reference-turn", status: "inProgress" } };
    if (!result) return original.call(this, raw);
    window.historyFixture.requests.push(request);
    setTimeout(
      () =>
        this.onmessage({ data: JSON.stringify({ id: request.id, result }) }),
      0,
    );
  };
}
