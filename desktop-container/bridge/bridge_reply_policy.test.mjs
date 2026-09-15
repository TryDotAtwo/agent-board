import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeRuntime } from "./bridge_runtime.mjs";
import { DeliveryQueue } from "./delivery_queue.mjs";
import { DeliveryWorker } from "./delivery_worker.mjs";

class Client extends EventEmitter {
  constructor() { super(); this.active = new Map(); this.nextTurn = 0; }
  getActiveTurnId(id) { return this.active.get(id); }
  async startTurn(id) {
    const turnId = `reply_policy_${++this.nextTurn}`;
    this.active.set(id, turnId);
    this.emit("turnStarted", { id: turnId, expertId: id });
    return { id: turnId };
  }
  async steerTurn() { throw new Error("unexpected steer"); }
}

async function deliverAnswer({ senderId, senderUsername, isBot, finalAnswer = "answer" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-reply-policy-"));
  const client = new Client();
  const telegram = { calls: [], async sendText(body) { this.calls.push(body); } };
  const queue = new DeliveryQueue({ root: path.join(root, "queue") });
  const worker = new DeliveryWorker({ queue, client: telegram });
  const state = { offset: 0, origins: {} };
  const runtime = new BridgeRuntime({ client, telegram, state, expectedChat: -100,
    botUsername: "target_expert_bot", deliveryQueue: queue, deliveryWorker: worker,
    outbox: { async listTurnArtifacts() { return []; } },
    saveState: async () => {}, archiveMessage: async () => {}, downloadAttachments: async (record) => record,
    batchDelayMs: 1, setTimer: () => ({ fake: true }), clearTimer: () => {} });
  assert.equal(await runtime.processUpdate({ update_id: 41, message: { message_id: 41, chat: { id: -100 },
    from: { id: senderId, username: senderUsername, is_bot: isBot }, text: "@target_expert_bot question" } }), "buffered");
  await runtime.flushInputs();
  const turnId = client.getActiveTurnId("default");
  client.active.delete("default");
  client.emit("turnCompleted", { id: turnId, expertId: "default", finalAnswer });
  await runtime.completions;
  await worker.drainDue();
  return telegram.calls;
}

test("ordinary expert answers may use Telegram reply", async () => {
  const [sent] = await deliverAnswer({ senderId: 7, senderUsername: "alice", isBot: false });
  assert.equal(sent.replyTo, 41);
});

test("requester answers keep a reply for deterministic MCP collection", async () => {
  const [sent] = await deliverAnswer({ senderId: 900, senderUsername: "requester_bot", isBot: true });
  assert.equal(sent.replyTo, 41);
});

test("a completed turn with no final text sends nothing to Telegram", async () => {
  const sent = await deliverAnswer({ senderId: 7, senderUsername: "alice", isBot: false, finalAnswer: "" });
  assert.deepEqual(sent, []);
});

test("commentary progress is plain while the final answer replies to the request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-commentary-policy-"));
  const client = new Client();
  const telegram = { calls: [], async sendText(body) { this.calls.push(body); } };
  const queue = new DeliveryQueue({ root: path.join(root, "queue") });
  const worker = new DeliveryWorker({ queue, client: telegram });
  const state = { offset: 0, origins: {} };
  let flushProgress;
  const runtime = new BridgeRuntime({ client, telegram, state, expectedChat: -100,
    botUsername: "target_expert_bot", deliveryQueue: queue, deliveryWorker: worker,
    outbox: { async listTurnArtifacts() { return []; } },
    saveState: async () => {}, archiveMessage: async () => {}, downloadAttachments: async (record) => record,
    batchDelayMs: 1, setTimer: (fn) => { flushProgress = fn; return { fake: true }; }, clearTimer: () => {} });
  await runtime.processUpdate({ update_id: 41, message: { message_id: 41, chat: { id: -100 },
    from: { id: 7, username: "alice", is_bot: false }, text: "@target_expert_bot question" } });
  await runtime.flushInputs();
  client.emit("commentary", { expertId: "default", text: "Проверяю" });
  await flushProgress();
  assert.equal(telegram.calls[0].replyTo, undefined);
  const turnId = client.getActiveTurnId("default");
  client.emit("turnCompleted", { id: turnId, expertId: "default", finalAnswer: "готово" });
  await runtime.completions;
  await worker.drainDue();
  assert.equal(telegram.calls[1].replyTo, 41);
});
