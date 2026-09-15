import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { selectCompletedChatReply } from "./chat_reply.mjs";
import { atomicJson } from "./atomic_json.mjs";

const ID = /^[a-f0-9]{64}$/;
const FILE = /^([a-f0-9]{64})\.json$/;
const STATUSES = new Set(["queued", "sending", "waiting", "completed", "blocked"]);
const READ_TURN_LIMIT = 10;
const READ_CHAR_LIMIT = 20000;
const TRUNCATED_REPLY_NOTICE = "Шлюз не смог получить ответ ChatGPT целиком из-за ограничения чтения. Полный ответ находится в исходном чате ChatGPT. Частичный текст не пересылается.";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validThread = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 256;
const validPrompt = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 19000
  && Buffer.byteLength(value, "utf8") <= 120000;
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const active = (record) => record.status === "sending" || record.status === "waiting"
  || (record.status === "blocked" && record.previousTurnIds !== undefined);

async function readJson(file, maxBytes) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw fail("INVALID_FILE");
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw fail("INVALID_FILE");
  return JSON.parse(text);
}

function validateRequest(value, id, threadId) {
  if (!object(value) || Object.keys(value).sort().join(",") !== "createdAt,id,prompt,threadId"
    || value.id !== id || !ID.test(value.id) || value.threadId !== threadId || !validPrompt(value.prompt)
    || typeof value.createdAt !== "string" || value.createdAt.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString().slice(0, 19) !== value.createdAt.slice(0, 19)) throw fail("INVALID_REQUEST");
  return value;
}

function validateLedger(value, id, threadId) {
  const fields = new Set(["id", "threadId", "status", "answer", "silent", "error", "previousTurnIds", "prompt", "emptySince"]);
  if (!object(value) || Object.keys(value).some((key) => !fields.has(key)) || value.id !== id
    || value.threadId !== threadId || !STATUSES.has(value.status)
    || (value.prompt !== undefined && !validPrompt(value.prompt))
    || (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 512))
    || (value.answer !== undefined && (typeof value.answer !== "string" || Buffer.byteLength(value.answer) > 4000000))
    || (value.silent !== undefined && value.silent !== true)
    || (value.emptySince !== undefined && (!Number.isSafeInteger(value.emptySince) || value.emptySince < 0))
    || (value.previousTurnIds !== undefined && (!Array.isArray(value.previousTurnIds) || value.previousTurnIds.length > READ_TURN_LIMIT
      || value.previousTurnIds.some((turnId) => typeof turnId !== "string" || !turnId || turnId.length > 512)))
    || ((active(value) || value.status === "queued" || value.status === "completed") && !validPrompt(value.prompt))
    || (active(value) && !Array.isArray(value.previousTurnIds))
    || (value.status !== "completed" && value.silent !== undefined)
    || (value.silent === true && value.answer !== undefined)
    || (value.status === "completed" && value.silent !== true && !value.answer?.trim())) throw fail("INVALID_LEDGER", "invalid ledger; refusing to send");
  return value;
}

function decodeSnapshot(result, threadId) {
  if (!object(result) || result.isError || !Array.isArray(result.content)) throw fail("INVALID_SNAPSHOT");
  const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  if (Buffer.byteLength(text) > 16000000) throw fail("INVALID_SNAPSHOT");
  const data = JSON.parse(text);
  if (data?.thread?.id !== threadId) throw fail("TARGET_MISMATCH");
  if (typeof data.thread.status?.type !== "string" || !Array.isArray(data.turns) || data.turns.length > READ_TURN_LIMIT
    || data.turns.some((turn) => typeof turn.id !== "string" || !turn.id || turn.id.length > 512)
    || new Set(data.turns.map((turn) => turn.id)).size !== data.turns.length) throw fail("INVALID_SNAPSHOT");
  return data;
}

export class ProGateway {
  #root;
  #threadId;
  #clientFactory;
  #client;
  #token = randomUUID();
  #ownsLock = false;
  #ready = false;
  #closed = false;
  #operation;
  #closing;
  #now;
  #silentGraceMs;

  constructor({ root, threadId, clientFactory, now = Date.now, silentGraceMs = 15000 } = {}) {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("INVALID_ROOT", "root must be an absolute path");
    if (!validThread(threadId)) throw fail("INVALID_TARGET", "threadId must be nonempty and at most 256 characters");
    if (typeof clientFactory !== "function") throw fail("INVALID_CLIENT", "clientFactory is required");
    if (typeof now !== "function" || !Number.isSafeInteger(silentGraceMs) || silentGraceMs < 1) throw fail("INVALID_OPTIONS");
    this.#root = path.resolve(root);
    this.#threadId = threadId;
    this.#clientFactory = clientFactory;
    this.#now = now;
    this.#silentGraceMs = silentGraceMs;
  }

  tick() {
    if (this.#closed) return Promise.reject(fail("GATEWAY_CLOSED"));
    if (this.#operation) return this.#operation;
    this.#operation = this.#tick().finally(() => { this.#operation = null; });
    return this.#operation;
  }

  async #initialize() {
    if (this.#ready) return;
    for (const directory of [this.#root, path.join(this.#root, "requests"), path.join(this.#root, "results")]) {
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail("INVALID_ROOT");
    }
    let lock;
    try { lock = await open(path.join(this.#root, ".pro-gateway.lock"), "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw fail("GATEWAY_LOCKED", "gateway lock already exists; verify owner before manual recovery");
      throw error;
    }
    this.#ownsLock = true;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, threadId: this.#threadId, startedAt: new Date().toISOString(), token: this.#token }));
      await lock.sync();
    } finally { await lock.close(); }
    this.#ready = true;
  }

  async #heartbeat(status = "running") {
    await atomicJson(path.join(this.#root, "heartbeat.json"), {
      version: 1, pid: process.pid, threadId: this.#threadId, status, updatedAt: new Date().toISOString(),
    });
  }

  async #persist(record) {
    validateLedger(record, record.id, this.#threadId);
    await atomicJson(path.join(this.#root, "results", `${record.id}.json`), record);
    return record;
  }

  async #tick() {
    await this.#initialize();
    await this.#heartbeat();
    const result = await this.#processOne();
    await this.#heartbeat();
    return result;
  }

  async #processOne() {
    const ledgers = new Map();
    for (const filename of await readdir(path.join(this.#root, "results"))) {
      const id = FILE.exec(filename)?.[1];
      if (!id) continue;
      const record = validateLedger(await readJson(path.join(this.#root, "results", filename), 4500000), id, this.#threadId);
      ledgers.set(id, record);
    }
    const jobs = [];
    for (const filename of await readdir(path.join(this.#root, "requests"))) {
      const id = FILE.exec(filename)?.[1];
      if (!id) continue; // Atomic temporary files and non-protocol names are never executed.
      let value;
      try { value = validateRequest(await readJson(path.join(this.#root, "requests", filename), 750000), id, this.#threadId); }
      catch {
        const prior = ledgers.get(id);
        if (prior && (prior.status !== "blocked" || active(prior))) throw fail("REQUEST_CONFLICT", "request identity conflicts with its ledger");
        if (!prior) jobs.push({ id, invalid: true, createdAt: "" });
        continue;
      }
      const record = ledgers.get(id);
      if (record?.prompt !== undefined && record.prompt !== value.prompt) throw fail("REQUEST_CONFLICT", "request identity conflicts with its ledger");
      if (!record || record.status === "queued") jobs.push(value);
    }
    const pending = [...ledgers.values()].filter(active);
    if (pending.length > 1) throw fail("MULTIPLE_ACTIVE", "multiple active ledgers require operator reconciliation");
    if (pending.length) return this.#reconcile(pending[0]);
    jobs.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.id.localeCompare(b.id));
    const job = jobs[0];
    if (!job) return null;
    if (job.invalid) return this.#persist({ id: job.id, threadId: this.#threadId, status: "blocked", error: "INVALID_REQUEST" });
    const queued = { id: job.id, threadId: this.#threadId, status: "queued", prompt: job.prompt };
    await this.#persist(queued);
    let data;
    try { data = await this.#read(); }
    catch (error) {
      this.#disconnect();
      return this.#persist({ ...queued, status: error.code === "TARGET_MISMATCH" ? "blocked" : "queued",
        error: error.code === "TARGET_MISMATCH" ? "TARGET_MISMATCH" : "DESKTOP_READ_UNAVAILABLE" });
    }
    if (this.#closed || data.thread.status.type !== "idle") return queued;
    const intent = { ...queued, status: "sending", previousTurnIds: data.turns.map((turn) => turn.id) };
    await this.#persist(intent);
    if (this.#closed) return intent; // Intent is deliberately reconciled, never sent again after shutdown.
    try { await this.#client.sendMessage(job.prompt); }
    catch {
      this.#disconnect();
      return this.#persist({ ...intent, status: "blocked", error: "SEND_AMBIGUOUS_RECONCILIATION_REQUIRED" });
    }
    return this.#persist({ ...intent, status: "waiting" });
  }

  async #read() {
    if (!this.#client) {
      this.#client = await this.#clientFactory({ threadId: this.#threadId });
      await this.#client.start();
    }
    return decodeSnapshot(await this.#client.readThread({ turnLimit: READ_TURN_LIMIT, maxOutputCharsPerItem: READ_CHAR_LIMIT }), this.#threadId);
  }

  #disconnect() {
    try { this.#client?.close(); } finally { this.#client = null; }
  }

  async #reconcile(record) {
    let data;
    try { data = await this.#read(); }
    catch (error) {
      this.#disconnect();
      return this.#persist({ ...record, status: "blocked",
        error: error.code === "TARGET_MISMATCH" ? "TARGET_MISMATCH" : "DESKTOP_READ_UNAVAILABLE_RECONCILIATION_REQUIRED" });
    }
    if (data.thread.status.type !== "idle") return record;
    const candidateTurns = data.turns.filter((turn) => !record.previousTurnIds.includes(turn.id) && Array.isArray(turn.items)
      && turn.items.some((item) => item.type === "userMessage" && Array.isArray(item.content)
        && item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") === record.prompt));
    const isFinal = (item) => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()
      && (item.phase === undefined || item.phase === "final_answer");
    if (candidateTurns.some((turn) => turn.items.some(isFinal) && (data.truncated === true || turn.truncated === true
      || turn.items.some((item) => isFinal(item) && (item.truncated === true || item.text.length >= READ_CHAR_LIMIT))))) {
      // A terminal local failure is visible to Telegram and can release FIFO;
      // it is not the remote answer and never contains a misleading excerpt.
      return this.#persist({ ...record, status: "completed", error: "ANSWER_POSSIBLY_TRUNCATED", answer: TRUNCATED_REPLY_NOTICE });
    }
    const answer = selectCompletedChatReply(data, { targetThreadId: this.#threadId,
      requestPrompt: record.prompt, previousTurnIds: record.previousTurnIds });
    if (answer !== null) {
      if (Buffer.byteLength(answer) > 4000000) return this.#persist({ ...record, status: "blocked", error: "ANSWER_TOO_LARGE" });
      const { error, emptySince, ...withoutError } = record;
      return this.#persist({ ...withoutError, status: "completed", answer });
    }
    if (data.truncated !== true && candidateTurns.some((turn) => turn.status === "completed"
      && turn.truncated !== true && !turn.items.some(isFinal)
      // A user-only cloud snapshot can look completed before generation appears.
      // Absence of an assistant message is not an intentional silent answer.
      && turn.items.some(item => item.type === "agentMessage" && item.phase === "final_answer"
        && typeof item.text === "string" && !item.text.trim() && item.truncated !== true))) {
      if (record.emptySince === undefined) return this.#persist({ ...record, status: "waiting", emptySince: this.#now() });
      if (this.#now() - record.emptySince < this.#silentGraceMs) return record;
      const { error, emptySince, ...withoutError } = record;
      return this.#persist({ ...withoutError, status: "completed", silent: true });
    }
    if (record.status === "waiting") return record;
    return this.#persist({ ...record, status: "blocked", error: "SEND_AMBIGUOUS_RECONCILIATION_REQUIRED" });
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      try { await this.#operation; } catch { /* Shutdown still releases this owner's resources. */ }
      this.#disconnect();
      if (!this.#ownsLock) return;
      try { await this.#heartbeat("closed"); }
      finally {
        const lockPath = path.join(this.#root, ".pro-gateway.lock");
        const record = await readJson(lockPath, 4096);
        if (record.token !== this.#token) throw fail("LOCK_OWNERSHIP_CHANGED");
        await unlink(lockPath);
        this.#ownsLock = false;
      }
    })();
    return this.#closing;
  }
}
