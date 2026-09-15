import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeliveryQueue } from "./delivery_queue.mjs";
import { DeliveryWorker } from "./delivery_worker.mjs";
import { PermanentTelegramError } from "./telegram_output.mjs";

class Telegram {
  constructor() { this.calls = []; this.failTransient = 0; this.permanent = false; }
  async sendText(body) {
    this.calls.push(["text", body.text]);
    if (this.permanent) throw new PermanentTelegramError("Bad Request", 400);
    if (this.failTransient-- > 0) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
  }
  async sendPhoto(body) { this.calls.push(["photo", body.artifact.artifactId]); }
  async sendDocument(body) { this.calls.push(["document", body.artifact.artifactId, body.replyTo]); }
}

let now = 0;
const root = await mkdtemp(path.join(os.tmpdir(), "delivery-worker-"));
const queue = new DeliveryQueue({ root, now: () => now });
const client = new Telegram();
client.failTransient = 1;
await queue.enqueue({ turnId: "turn_retry", chatId: -100, replyTo: 1, textChunks: ["one", "two"], artifacts: [
  { artifactId: "a1", path: "/data/outbox/a.ipynb", mimeType: "application/x-ipynb+json", size: 10 },
] });
const deliveries = [];
const worker = new DeliveryWorker({ queue, client, now: () => now, recordDelivery: async (...args) => deliveries.push(args),
  setTimer: () => ({ fake: true }), clearTimer: () => {} });
await worker.drainDue();
let pending = await queue.load("turn_retry");
assert.equal(pending.attempt, 1);
assert.equal(pending.nextAttemptAt, 1000);
assert.equal(pending.nextTextIndex, 0);
now = 1000;
await worker.drainDue();
assert.equal(await queue.load("turn_retry"), undefined);
assert.deepEqual(client.calls.map((call) => call[0]), ["text", "text", "text", "document"]);
assert.deepEqual(deliveries, [["a1", "delivered"]]);

await queue.enqueue({ turnId: "turn_restart", chatId: -100, replyTo: 2, textChunks: ["sent", "resume"], artifacts: [] });
await queue.advance("turn_restart", { nextTextIndex: 1 });
const restartedClient = new Telegram();
const restarted = new DeliveryWorker({ queue: new DeliveryQueue({ root, now: () => now }), client: restartedClient,
  now: () => now, setTimer: () => ({ fake: true }), clearTimer: () => {} });
await restarted.drainDue();
assert.deepEqual(restartedClient.calls, [["text", "resume"]]);
assert.equal(await queue.load("turn_restart"), undefined);

await queue.enqueue({ turnId: "turn_block", chatId: -100, textChunks: ["bad"], artifacts: [] });
const permanentClient = new Telegram(); permanentClient.permanent = true;
const permanentWorker = new DeliveryWorker({ queue, client: permanentClient, now: () => now,
  setTimer: () => ({ fake: true }), clearTimer: () => {} });
await permanentWorker.drainDue();
assert.equal((await queue.load("turn_block")).status, "blocked");
assert.equal(permanentClient.calls.length, 1);
await permanentWorker.drainDue();
assert.equal(permanentClient.calls.length, 1);

const staleLogs = [];
await queue.enqueue({ turnId: "turn_stale", chatId: -100, textChunks: ["old"], artifacts: [] });
now += 300001;
const staleClient = new Telegram(); staleClient.failTransient = 1;
const staleWorker = new DeliveryWorker({ queue, client: staleClient, now: () => now, log: async (line) => staleLogs.push(line),
  setTimer: () => ({ fake: true }), clearTimer: () => {} });
await staleWorker.drainDue();
assert.ok(staleLogs.some((line) => /stale delivery.*turn_stale/i.test(line)));

await queue.enqueue({ turnId: "turn_document_only", chatId: -100, replyTo: 79, textChunks: [], artifacts: [
  { artifactId: "answer", path: "/data/outbox/answer.md", mimeType: "text/markdown", size: 9000 },
] });
const documentClient = new Telegram();
const documentWorker = new DeliveryWorker({ queue, client: documentClient, now: () => now,
  setTimer: () => ({ fake: true }), clearTimer: () => {} });
await documentWorker.drainDue();
assert.deepEqual(documentClient.calls, [["document", "answer", 79]]);
console.log("PASS transient eventual delivery, cursor restart, artifact ack, and permanent blocking");
