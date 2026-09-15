import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_EXECUTABLE = "/usr/local/bin/board-chromium";

function safeSegment(value) {
  const segment = String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!segment || segment === "." || segment === "..") throw new Error("invalid expert id");
  return segment;
}

export function playwrightLaunchOptions({ outputDir, executablePath = DEFAULT_EXECUTABLE, profileDir, headless=true }) {
  const env=Object.fromEntries(['PATH','HOME','DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG','TMPDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  return { command: "playwright-mcp", args: [
    ...(headless?['--headless']:[]), ...(profileDir?['--user-data-dir',profileDir]:['--isolated']), "--output-dir", outputDir,
    "--executable-path", executablePath,
  ], spawnOptions: { cwd: outputDir, env, stdio: ["pipe", "pipe", "pipe"] } };
}

function defaultSpawnServer(_expertId, options) {
  const launch = playwrightLaunchOptions(options);
  return spawn(launch.command, launch.args, launch.spawnOptions);
}

class McpClient extends EventEmitter {
  constructor({ child, expertId, requestTimeoutMs }) {
    super();
    Object.assign(this, { child, expertId, requestTimeoutMs });
    this.nextId = 1;
    this.pending = new Map();
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.#onLine(line));
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => this.emit("stderr", String(chunk)));
    child.on("error", (error) => this.#fail(error));
    child.on("close", (code, signal) => this.#fail(new Error(`Playwright MCP for ${expertId} closed code=${code} signal=${signal || "none"}`)));
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "cayleypy-telegram", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    return this.request("tools/list", {});
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Playwright MCP ${method} timed out for ${this.expertId}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close() {
    this.lines.close();
    this.child.kill();
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit("warning", `Invalid Playwright MCP JSON: ${line.slice(0, 200)}`); return; }
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  #fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("fatal", error);
  }
}

export class PlaywrightMcpPool extends EventEmitter {
  constructor({ outputRoot = "/data/playwright", executablePath = DEFAULT_EXECUTABLE, profileRoot, headless=true,
    requestTimeoutMs = 120000, spawnServer = defaultSpawnServer } = {}) {
    super();
    Object.assign(this, { outputRoot: path.resolve(outputRoot), executablePath, requestTimeoutMs, spawnServer });
    Object.assign(this,{profileRoot,headless});
    this.clients = new Map();
    this.starting = new Map();
  }

  startExpert(expertId) {
    if (this.clients.has(expertId)) return Promise.resolve(this.toolsFor(expertId));
    if (this.starting.has(expertId)) return this.starting.get(expertId);
    const promise = this.#start(expertId).finally(() => this.starting.delete(expertId));
    this.starting.set(expertId, promise);
    return promise;
  }

  async #start(expertId) {
    const outputDir = path.join(this.outputRoot, safeSegment(expertId));
    await mkdir(outputDir, { recursive: true });
    const profileDir=this.profileRoot?path.join(this.profileRoot,safeSegment(expertId)):undefined;
    if(profileDir)await mkdir(profileDir,{recursive:true,mode:0o700});
    const child = this.spawnServer(expertId, { outputDir, executablePath: this.executablePath,profileDir,headless:this.headless });
    const client = new McpClient({ child, expertId, requestTimeoutMs: this.requestTimeoutMs });
    client.on("stderr", (message) => this.emit("stderr", { expertId, message }));
    client.on("warning", (message) => this.emit("warning", { expertId, message }));
    client.on("fatal", (error) => this.emit("fatal", { expertId, error }));
    const listed = await client.initialize();
    client.tools = listed.tools || [];
    this.clients.set(expertId, client);
    return client.tools;
  }

  toolsFor(expertId) {
    const client = this.clients.get(expertId);
    if (!client) throw new Error(`Playwright MCP is not started for ${expertId}`);
    return client.tools;
  }

  async call(expertId, tool, args = {}) {
    const client = this.clients.get(expertId);
    if (!client) throw new Error(`Playwright MCP is not started for ${expertId}`);
    if (!client.tools.some((item) => item.name === tool)) throw new Error(`unknown Playwright tool: ${tool}`);
    return client.request("tools/call", { name: tool, arguments: args });
  }

  close() {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
