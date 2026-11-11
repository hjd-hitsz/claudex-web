import { readFileSync } from "node:fs";
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url)),
);
export function serveDemoSession(request, response) {
  if (
    request.url === "/api/maintenance" ||
    request.url === "/api/maintenance/check"
  ) {
    response
      .writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(
        JSON.stringify({
          current: version,
          latest: version,
          checkedAt: new Date().toISOString(),
          error: "",
          npmInstalled: false,
          managed: false,
          updateAvailable: false,
          task: null,
        }),
      );
    return true;
  }
  if (request.url !== "/api/auth/session") return false;
  response
    .writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    })
    .end(
      JSON.stringify({
        authenticated: true,
        username: "demo",
        expiresAt: Date.now() + 86400000,
      }),
    );
  return true;
}
