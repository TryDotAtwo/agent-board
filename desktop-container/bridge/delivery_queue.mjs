import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const TURN_ID = /^[A-Za-z0-9_-]{1,160}$/;

function validateTurnId(turnId) {
  if (!TURN_ID.test(String(turnId || ""))) throw new Error("invalid delivery turn id");
  return String(turnId);
}

function validateArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error("artifacts must be an array");
  for (const item of artifacts) {
    if (!item?.artifactId || !item?.path || !item?.mimeType || !Number.isFinite(item?.size)) {
      throw new Error("invalid delivery artifact record");
    }
  }
}

function sanitizedError(value) {
  return String(value || "delivery failed")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:token|secret|key|password)\s*[=:]\s*\S+/gi, "[credential]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 500);
}

export class DeliveryQueue {
  constructor({ root = "/data/delivery-queue", now = () => Date.now() } = {}) {
    this.root = path.resolve(root);
    this.now = now;
  }

  async enqueue(input) {
    const turnId = validateTurnId(input?.turnId);
    validateArtifacts(input.artifacts || []);
    const existing = await this.load(turnId);
    if (existing) return existing;
    const timestamp = new Date(this.now()).toISOString();
    const job = {
      version: 1, turnId, chatId: input.chatId, replyTo: input.replyTo,
      ...(input.topicId ? { topicId: input.topicId } : {}),
      textChunks: [...(input.textChunks || [])], artifacts: input.artifacts.map((item) => ({ ...item })),
      nextTextIndex: 0, nextArtifactIndex: 0, attempt: 0, nextAttemptAt: 0,
      status: "pending", createdAt: timestamp, updatedAt: timestamp,
    };
    await this.#write(job);
    return job;
  }

  async load(turnId) {
    const file = this.#path(validateTurnId(turnId));
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  }

  async list() {
    await mkdir(this.root, { recursive: true });
    const names = (await readdir(this.root)).filter((name) => name.endsWith(".json")).sort();
    const jobs = [];
    for (const name of names) jobs.push(JSON.parse(await readFile(path.join(this.root, name), "utf8")));
    return jobs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async advance(turnId, patch) {
    const job = await this.load(turnId);
    if (!job) throw new Error("delivery job not found");
    Object.assign(job, patch, { updatedAt: new Date(this.now()).toISOString() });
    await this.#write(job);
    return job;
  }

  block(turnId, error) {
    return this.advance(turnId, { status: "blocked", lastError: sanitizedError(error), nextAttemptAt: 0 });
  }

  async complete(turnId) {
    try { await unlink(this.#path(validateTurnId(turnId))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  #path(turnId) { return path.join(this.root, `${turnId}.json`); }

  async #write(job) {
    await mkdir(this.root, { recursive: true });
    const destination = this.#path(validateTurnId(job.turnId));
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  }
}

export { sanitizedError as sanitizeDeliveryError };
