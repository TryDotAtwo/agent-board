import http from "node:http";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

async function readJson(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body exceeds limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

function publicResult(result) {
  return { ...result, answers: Object.fromEntries(Object.entries(result.answers || {}).map(([expertId, answer]) => [expertId, {
    ...answer, attachments: (answer.attachments || []).map(({ path: _privatePath, ...item }) => ({ ...item,
      ...(_privatePath ? { download_path: `/v1/files/${encodeURIComponent(result.requestId)}/${encodeURIComponent(expertId)}/${encodeURIComponent(path.basename(_privatePath))}` } : {}),
    })),
  }])) };
}

export function createRequesterHttpServer({ broker, token, attachmentRoot, host = "0.0.0.0", port = 48732 }) {
  if (!token) throw new Error("TELEGRAM_MCP_TOKEN is required");
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true });
      if (request.method === "GET" && request.url?.startsWith("/v1/files/")) {
        if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });
        const parts = request.url.slice("/v1/files/".length).split("/").map(decodeURIComponent);
        if (!attachmentRoot || parts.length !== 3 || parts.some((part) => !/^[\p{L}\p{N}._-]+$/u.test(part) || part === "." || part === "..")) {
          return json(response, 404, { error: "not found" });
        }
        const root = await realpath(attachmentRoot);
        const file = await realpath(path.join(root, ...parts));
        const relative = path.relative(root, file);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return json(response, 404, { error: "not found" });
        const bytes = await readFile(file);
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
        return response.end(bytes);
      }
      if (request.method !== "POST" || request.url !== "/v1/ask") return json(response, 404, { error: "not found" });
      if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });
      const body = await readJson(request);
      const allowed = new Set(["experts", "question", "timeoutSeconds"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) return json(response, 400, { error: "unsupported field" });
      const result = await broker.ask(body);
      return json(response, 200, publicResult(result));
    } catch (error) {
      return json(response, 400, { error: String(error?.message || error) });
    }
  });
  return {
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(server.address()); });
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
