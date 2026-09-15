import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const historyTools = [
  { name: "list_project_threads", description: "List Windows Codex tasks belonging to this thread's project.", annotations: readOnly,
    inputSchema: { type: "object", properties: { cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } } } },
  { name: "search_project_threads", description: "Search original Windows Codex conversations belonging to this thread's project.", annotations: readOnly,
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2 }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["query"] } },
  { name: "read_project_thread", description: "Read an original Windows Codex conversation belonging to this thread's project.", annotations: readOnly,
    inputSchema: { type: "object", properties: { threadId: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 }, includeOutputs: { type: "boolean" }, maxOutputChars: { type: "integer", minimum: 1, maximum: 120000 } }, required: ["threadId"] } },
  { name: "read_thread_attachment", description: "Read a bounded attachment referenced by an allowed Windows Codex conversation.", annotations: readOnly,
    inputSchema: { type: "object", properties: { threadId: { type: "string" }, attachmentId: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 1000000 } }, required: ["threadId", "attachmentId"] } },
];

const routeByTool = {
  list_project_threads: "/v1/threads/list",
  search_project_threads: "/v1/threads/search",
  read_project_thread: "/v1/threads/read",
  read_thread_attachment: "/v1/attachments/read",
};

export function createHistoryMcp({ contextPath, credentials = {}, gatewayUrl, fetchImpl = fetch }) {
  if (!contextPath) throw new Error("active expert context path is required");
  const client = createHistoryClient({ credentials, gatewayUrl, fetchImpl });
  return {
    tools: historyTools,
    async callTool(name, args = {}) {
      let context;
      try { context = JSON.parse(await readFile(contextPath, "utf8")); }
      catch { throw new Error("active expert context is unavailable"); }
      if (!context?.expertId || !context?.threadId) throw new Error("active expert context is invalid");
      try { return await client.call({ expertId: context.expertId, tool: name, arguments: args }); }
      catch (error) {
        if (/unknown expert/i.test(error.message)) throw new Error("unknown active expert");
        throw error;
      }
    },
  };
}

export function createHistoryClient({ credentials = {}, gatewayUrl, fetchImpl = fetch }) {
  if (!gatewayUrl) throw new Error("history gateway URL is required");
  return {
    async call({ expertId, tool, arguments: args = {} }) {
      const route = routeByTool[tool];
      if (!route) throw new Error(`unknown tool: ${tool}`);
      const token = credentials[expertId];
      if (!token) throw new Error("unknown expert");
      const response = await fetchImpl(`${gatewayUrl.replace(/\/$/, "")}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      const text = await response.text();
      if (!response.ok) {
        let message = `history gateway HTTP ${response.status}`;
        try { message = JSON.parse(text).error || message; } catch {}
        throw new Error(message);
      }
      return text;
    },
  };
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let credentials = {};
  try { credentials = JSON.parse(process.env.HISTORY_EXPERT_CREDENTIALS || "{}"); } catch {}
  const mcp = createHistoryMcp({
    contextPath: process.env.ACTIVE_EXPERT_CONTEXT || "/data/runtime/active-expert.json",
    credentials,
    gatewayUrl: process.env.HISTORY_GATEWAY_URL || "http://host.docker.internal:48731",
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", async (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.id == null) return;
    try {
      if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "windows-codex-history", version: "1.0.0" } } });
      else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: mcp.tools } });
      else if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: await mcp.callTool(request.params.name, request.params.arguments || {}) }] } });
      else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } });
    } catch (error) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: String(error.message || error) }] } });
    }
  });
}
