export function createMaintenanceHandler(service) {
  return async (request, response, path) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    try {
      let result;
      if (path === "/api/maintenance" && request.method === "GET")
        result = await service.status();
      else if (request.method === "POST" && path === "/api/maintenance/check") {
        await service.check();
        result = await service.status();
      } else if (
        request.method === "POST" &&
        ["/api/maintenance/update", "/api/maintenance/restart"].includes(path)
      ) {
        result = await service.start(path.split("/").at(-1));
      } else {
        response.writeHead(405);
        response.end(JSON.stringify({ error: "请求方法或维护操作无效" }));
        return;
      }
      response.writeHead(200);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(409);
      response.end(JSON.stringify({ error: error.message }));
    }
  };
}
