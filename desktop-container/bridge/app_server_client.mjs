import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_CONFIG = Object.freeze({
  model: "gpt-5.6-sol",
  effort: "low",
  approvalPolicy: "never",
  sandbox: "read-only",
  sandboxPolicy: { type: "readOnly", networkAccess: true },
});

function dynamicContent(value) {
  if (!Array.isArray(value?.content)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return [{ type: "inputText", text }];
  }
  return value.content.flatMap((item) => {
    if (item?.type === "text") return [{ type: "inputText", text: String(item.text || "") }];
    if (item?.type === "image" && item.data && item.mimeType) {
      return [{ type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` }];
    }
    if (item?.type === "audio" && item.data && item.mimeType) {
      return [{ type: "inputAudio", audioUrl: `data:${item.mimeType};base64,${item.data}` }];
    }
    return [{ type: "inputText", text: JSON.stringify(item) }];
  });
}

function defaultSpawnServer() {
  return spawn("codex", ["app-server", "--listen", "stdio://"], {
    cwd: "/workspace",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export class AppServerClient extends EventEmitter {
  constructor({ spawnServer = defaultSpawnServer, toolDispatcher } = {}) {
    super();
    this.spawnServer = spawnServer;
    this.toolDispatcher = toolDispatcher;
    this.nextId = 1;
    this.pending = new Map();
    this.finalAnswers = new Map();
    this.contexts = new Map();
    this.threadExperts = new Map();
    this.turnExperts = new Map();
    this.closing = false;
  }

  async start() {
    if (this.child) return;
    this.closing = false;
    this.child = this.spawnServer();
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.#onLine(line));
    this.child.stderr?.setEncoding?.("utf8");
    this.child.stderr?.on?.("data", (chunk) => this.emit("serverStderr", String(chunk)));
    this.child.on("error", (error) => this.#onFatal(error));
    this.child.on("close", (code, signal) => {
      if (!this.closing) this.#onFatal(new Error(`Codex App Server closed code=${code} signal=${signal || "none"}`));
    });
    await this.request("initialize", {
      clientInfo: { name: "cayleypy-telegram", title: "CayleyPy Telegram Codex", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex App Server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async startOrResumeThread(expertId, options = {}) {
    const config = { ...DEFAULT_CONFIG, ...options };
    if (!config.cwd) throw new Error(`Missing cwd for ${expertId}`);
    const result = config.threadId
      ? await this.request("thread/resume", { threadId: config.threadId,
          ...(config.threadConfig ? { config: config.threadConfig } : {}),
          ...(config.developerInstructions ? { developerInstructions: config.developerInstructions } : {}),
          ...(config.dynamicTools ? { dynamicTools: config.dynamicTools } : {}) })
      : await this.request("thread/start", {
          cwd: config.cwd,
          model: config.model,
          approvalPolicy: config.approvalPolicy,
          sandbox: config.sandbox,
          ephemeral: false,
          ...(config.threadConfig ? { config: config.threadConfig } : {}),
          ...(config.developerInstructions ? { developerInstructions: config.developerInstructions } : {}),
          ...(config.dynamicTools ? { dynamicTools: config.dynamicTools } : {}),
        });
    const context = { ...config, threadId: result.thread.id, activeTurnId: undefined };
    this.contexts.set(expertId, context);
    this.threadExperts.set(result.thread.id, expertId);
    this.emit("threadReady", { ...result.thread, expertId });
    return result.thread;
  }

  getThreadId(expertId) { return this.contexts.get(expertId)?.threadId; }
  getActiveTurnId(expertId) { return this.contexts.get(expertId)?.activeTurnId; }

  async startTurn(expertId, input) {
    const context = this.contexts.get(expertId);
    if (!context?.threadId) throw new Error(`No Codex thread is loaded for ${expertId}`);
    if (context.activeTurnId) throw new Error(`Turn already active for ${expertId}`);
    let result;
    try {
      result = await this.request("turn/start", { threadId: context.threadId, input,
        cwd: context.cwd, model: context.model, effort: context.effort,
        approvalPolicy: context.approvalPolicy, sandboxPolicy: context.sandboxPolicy });
    } catch (error) { throw error; }
    context.activeTurnId = result.turn.id;
    this.turnExperts.set(result.turn.id, expertId);
    this.finalAnswers.set(result.turn.id, "");
    this.emit("turnStarted", { ...result.turn, expertId });
    return result.turn;
  }

  async steerTurn(expertId, input) {
    const context = this.contexts.get(expertId);
    if (!context?.threadId || !context.activeTurnId) throw new Error(`No active turn for ${expertId}`);
    return this.request("turn/steer", {
      threadId: context.threadId,
      input,
      expectedTurnId: context.activeTurnId,
    });
  }

  close() {
    this.closing = true;
    this.lines?.close();
    this.child?.kill?.();
    this.child = undefined;
    const error = new Error("Codex App Server client closed");
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit("warning", `Invalid App Server JSON: ${line.slice(0, 200)}`); return; }

    if (message.id != null && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      if (message.method === "item/tool/call") void this.#handleToolCall(message);
      else this.#declineServerRequest(message);
      return;
    }
    if (message.method) this.#onNotification(message.method, message.params || {});
  }

  #declineServerRequest(message) {
    let result = { decision: "decline" };
    if (message.method === "item/tool/requestUserInput") result = { answers: {} };
    this.child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
    this.emit("approvalDeclined", { method: message.method, params: message.params });
  }

  #onNotification(method, params) {
    this.emit("notification", { method, params });
    if (method === "turn/started") {
      const expertId = this.threadExperts.get(params.threadId);
      const turnId = params.turn?.id;
      if (expertId && turnId) {
        this.contexts.get(expertId).activeTurnId = turnId;
        this.turnExperts.set(turnId, expertId);
        this.finalAnswers.set(turnId, "");
      }
      this.emit("turnStarted", { ...params.turn, expertId });
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const text = params.item.text || "";
      const expertId = this.turnExperts.get(params.turnId) || this.threadExperts.get(params.threadId);
      if (params.item.phase === "commentary") this.emit("commentary", { text, item: params.item, turnId: params.turnId, expertId });
      else {
        this.finalAnswers.set(params.turnId, text);
        this.emit("agentMessage", { text, item: params.item, turnId: params.turnId, expertId });
      }
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.emit("activity", { method, item: params.item, turnId: params.turnId,
        expertId: this.turnExperts.get(params.turnId) || this.threadExperts.get(params.threadId) });
      return;
    }
    if (method === "turn/plan/updated") {
      this.emit("activity", { method, plan: params.plan, turnId: params.turnId,
        expertId: this.turnExperts.get(params.turnId) || this.threadExperts.get(params.threadId) });
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn || {};
      const expertId = this.turnExperts.get(turn.id) || this.threadExperts.get(params.threadId);
      const completed = { ...turn, expertId, finalAnswer: this.finalAnswers.get(turn.id) || "" };
      this.finalAnswers.delete(turn.id);
      this.turnExperts.delete(turn.id);
      const context = this.contexts.get(expertId);
      if (context?.activeTurnId === turn.id) context.activeTurnId = undefined;
      this.emit("turnCompleted", completed);
      return;
    }
    if (method === "warning" || method === "error") this.emit("warning", params.message || params.error?.message || method);
  }

  #onFatal(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.emit("fatal", error);
  }

  async #handleToolCall(message) {
    const params = message.params || {};
    const byThread = this.threadExperts.get(params.threadId);
    const byTurn = this.turnExperts.get(params.turnId);
    let result;
    try {
      if (!this.toolDispatcher) throw new Error("turn-bound tools are unavailable");
      if (!byThread || !byTurn || byThread !== byTurn) throw new Error("turn-bound tool identity mismatch");
      const value = await this.toolDispatcher.call({ ...params, expertId: byThread });
      result = { success: value?.isError !== true, contentItems: dynamicContent(value) };
    } catch (error) {
      result = { success: false, contentItems: [{ type: "inputText", text: String(error?.message || error) }] };
    }
    this.child?.stdin?.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }

}
