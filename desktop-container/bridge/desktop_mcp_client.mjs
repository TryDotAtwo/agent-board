import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ALLOWED_TOOLS = new Set(["read_thread", "send_message_to_thread"]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}
function failure(message, code, ambiguous = false) {
  return Object.assign(new Error(message), { code, ambiguous });
}
function validContent(item) {
  if (!isObject(item)) return false;
  if (item.type === "text") return typeof item.text === "string";
  if (item.type === "image" || item.type === "audio") return typeof item.data === "string" && typeof item.mimeType === "string";
  return false; // Stock codex-app-tools maps only text, images, and audio.
}

export class DesktopMcpClient {
  #sourceThreadId;
  #targetThreadId;
  #spawnServer;
  #child;
  #lines;
  #pending = new Map();
  #nextId = 1;
  #catalog = [];
  #advertised = new Set();
  #closed = false;
  #initialized = false;
  #startPromise;
  #requestTimeoutMs;
  #listToolsAttempts;
  #listToolsRetryMs;

  constructor({ serverPath, spawnServer, sourceThreadId = process.env.CODEX_THREAD_ID, targetThreadId,
    requestTimeoutMs = 30000, listToolsAttempts = 3, listToolsRetryMs = 200 } = {}) {
    this.#sourceThreadId = requiredString(sourceThreadId, "sourceThreadId");
    this.#targetThreadId = requiredString(targetThreadId, "targetThreadId");
    this.#requestTimeoutMs = boundedInteger(requestTimeoutMs, "requestTimeoutMs", 1, 300000);
    this.#listToolsAttempts = boundedInteger(listToolsAttempts, "listToolsAttempts", 1, 10);
    this.#listToolsRetryMs = boundedInteger(listToolsRetryMs, "listToolsRetryMs", 0, 10000);
    if (!spawnServer) requiredString(serverPath, "serverPath");
    if (spawnServer !== undefined && typeof spawnServer !== "function") throw new Error("spawnServer must be a function");
    this.#spawnServer = spawnServer || (() => spawn(process.execPath, [serverPath], {
      env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }));
  }

  get tools() { return structuredClone(this.#catalog); }

  async start() {
    this.#assertOpen();
    this.#startPromise ||= this.#start().catch((error) => { this.close(); throw error; });
    return this.#startPromise;
  }

  async #start() {
    this.#child = this.#spawnServer();
    this.#lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    this.#lines.on("line", (line) => this.#onLine(line));
    this.#child.on("error", () => this.#stop(failure("MCP process error; client closed", "MCP_CLOSED")));
    this.#child.on("close", () => this.#stop(failure("MCP process closed", "MCP_CLOSED")));
    this.#child.stdin.on("error", () => this.#stop(failure("MCP input closed", "MCP_CLOSED")));
    this.#child.stdout.on("error", () => this.#stop(failure("MCP output closed", "MCP_CLOSED")));
    this.#child.stdout.on("end", () => this.#stop(failure("MCP output closed", "MCP_CLOSED")));
    this.#child.stderr?.resume(); // Drain without logging possible account/private diagnostics.
    const result = await this.#request("initialize", { protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "pro-desktop-spike", version: "0.1.0" } });
    if (!isObject(result) || result.protocolVersion !== "2025-03-26" || !isObject(result.capabilities)
      || !isObject(result.serverInfo) || typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string") {
      throw failure("malformed or unsupported MCP initialize result", "MCP_PROTOCOL");
    }
    this.#assertOpen();
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    this.#initialized = true;
    return this.listTools();
  }

  #assertOpen() {
    if (this.#closed) throw failure("MCP client closed", "MCP_CLOSED");
  }

  #request(method, params = {}) {
    this.#assertOpen();
    if (!this.#child?.stdin?.writable) return Promise.reject(failure("MCP client is not started", "MCP_NOT_STARTED"));
    const id = this.#nextId++;
    const ambiguous = method === "tools/call" && params.name === "send_message_to_thread";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(failure(`MCP ${method} timed out${ambiguous ? "; send outcome is ambiguous; do not retry automatically" : ""}`, "MCP_TIMEOUT", ambiguous));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer, ambiguous });
      try {
        this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error) this.#stop(failure("MCP input failed; client closed", "MCP_CLOSED"));
        });
      } catch { this.#stop(failure("MCP write failed; client closed", "MCP_CLOSED")); }
    });
  }

  async listTools() {
    this.#assertOpen();
    if (!this.#initialized) throw failure("MCP client is not initialized", "MCP_NOT_STARTED");
    for (let attempt = 0; attempt < this.#listToolsAttempts; attempt += 1) {
      const result = await this.#request("tools/list");
      if (!isObject(result) || !Array.isArray(result.tools) || result.tools.some((tool) =>
        !isObject(tool) || typeof tool.name !== "string" || !tool.name.trim() || !isObject(tool.inputSchema) || tool.inputSchema.type !== "object")
        || new Set(result.tools.map((tool) => tool.name)).size !== result.tools.length || result.nextCursor != null) {
        throw failure("malformed or unsupported MCP tool catalog", "MCP_PROTOCOL");
      }
      this.#catalog = structuredClone(result.tools);
      this.#advertised = new Set(result.tools.map((tool) => tool.name));
      if (result.tools.length || attempt + 1 === this.#listToolsAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, this.#listToolsRetryMs));
      this.#assertOpen();
    }
    return this.tools;
  }

  readThread(options = {}) { return this.callTool("read_thread", options); }
  sendMessage(prompt) { return this.callTool("send_message_to_thread", { prompt }); }

  async callTool(name, args = {}) {
    this.#assertOpen();
    if (!ALLOWED_TOOLS.has(name)) throw new Error(`unsupported tool: ${name}`);
    if (!this.#initialized) throw failure("MCP client is not initialized", "MCP_NOT_STARTED");
    if (!this.#advertised.has(name)) throw new Error(`tool is not advertised and is unavailable: ${name}`);
    if (!isObject(args)) throw new Error("tool arguments must be an object");
    if (Object.hasOwn(args, "threadId") && args.threadId !== this.#targetThreadId) throw new Error("threadId must match the configured target");
    const allowed = name === "read_thread" ? ["threadId", "turnLimit", "maxOutputCharsPerItem"] : ["threadId", "prompt"];
    for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`unsupported argument: ${key}`);
    const input = { threadId: this.#targetThreadId };
    if (name === "read_thread") {
      if (args.turnLimit !== undefined) input.turnLimit = boundedInteger(args.turnLimit, "turnLimit", 1, 10);
      if (args.maxOutputCharsPerItem !== undefined) input.maxOutputCharsPerItem = boundedInteger(args.maxOutputCharsPerItem, "maxOutputCharsPerItem", 0, 20000);
    } else input.prompt = requiredString(args.prompt, "prompt");
    const result = await this.#request("tools/call", { name, arguments: input,
      _meta: { "x-codex-turn-metadata": { thread_id: this.#sourceThreadId } } });
    if (!isObject(result) || !Array.isArray(result.content) || result.content.some((item) => !validContent(item))
      || (result.isError !== undefined && typeof result.isError !== "boolean")) throw failure("malformed MCP tool result", "MCP_PROTOCOL", name === "send_message_to_thread");
    if (result.isError) throw failure(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "MCP tool returned isError", "MCP_TOOL_ERROR", name === "send_message_to_thread");
    return result;
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.#stop(failure("malformed MCP JSON; client closed", "MCP_PROTOCOL")); return; }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      this.#stop(failure("malformed MCP response; client closed", "MCP_PROTOCOL")); return;
    }
    if (message.id == null) return; // Server notifications do not complete requests.
    const pending = this.#pending.get(message.id);
    if (!pending) return; // Late responses never trigger another request, especially send.
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, "error") && !Object.hasOwn(message, "result") && isObject(message.error)
      && Number.isInteger(message.error.code) && typeof message.error.message === "string") {
      pending.reject(failure(message.error.message, message.error.code, pending.ambiguous));
    } else if (Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) pending.resolve(message.result);
    else pending.reject(failure("malformed MCP response", "MCP_PROTOCOL", pending.ambiguous));
  }

  #stop(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure(error.message, error.code, pending.ambiguous));
    }
    this.#pending.clear();
    this.#lines?.close();
    this.#child?.kill();
  }

  close() { this.#stop(failure("MCP client closed", "MCP_CLOSED")); }
}
