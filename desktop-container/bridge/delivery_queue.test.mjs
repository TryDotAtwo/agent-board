import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeliveryQueue } from "./delivery_queue.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "delivery-queue-"));
const queue = new DeliveryQueue({ root });
const input = {
  turnId: "turn_1", chatId: -100, replyTo: 42, textChunks: ["one", "two"],
  artifacts: [{ artifactId: "a1", path: "/data/outbox/a.ipynb", mimeType: "application/x-ipynb+json", size: 12, caption: "result" }],
};
const created = await queue.enqueue(input);
assert.equal(created.status, "pending");
assert.equal(created.nextTextIndex, 0);
assert.equal(created.nextArtifactIndex, 0);
assert.equal((await queue.enqueue({ ...input, textChunks: ["changed"] })).textChunks[0], "one");

await queue.advance("turn_1", { nextTextIndex: 1, attempt: 2, nextAttemptAt: 1234 });
const reopened = new DeliveryQueue({ root });
assert.deepEqual(Object.fromEntries(Object.entries(await reopened.load("turn_1")).filter(([key]) => ["nextTextIndex", "attempt", "nextAttemptAt"].includes(key))), {
  nextTextIndex: 1, attempt: 2, nextAttemptAt: 1234,
});
assert.equal((await reopened.list()).length, 1);

await reopened.block("turn_1", "https://api.telegram.org/botSECRET/sendMessage token=SECRET bad request");
const blocked = await reopened.load("turn_1");
assert.equal(blocked.status, "blocked");
assert.doesNotMatch(blocked.lastError, /https:|SECRET|token=/i);

await reopened.complete("turn_1");
assert.equal(await reopened.load("turn_1"), undefined);
await assert.rejects(() => queue.enqueue({ ...input, turnId: "../escape" }), /turn id/i);
await assert.rejects(() => queue.enqueue({ ...input, turnId: "bad_artifact", artifacts: [{ artifactId: "a" }] }), /artifact/i);
console.log("PASS durable enqueue, idempotency, atomic cursor resume, blocking, validation, and completion");
