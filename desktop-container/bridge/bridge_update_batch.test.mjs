import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BridgeRuntime } from "./bridge_runtime.mjs";

class Client extends EventEmitter {
  constructor() { super(); this.calls = []; this.active = new Map(); }
  getActiveTurnId(id) { return this.active.get(id); }
  async startTurn(id, input) {
    this.calls.push(input);
    this.active.set(id, "turn-1");
    return { id: "turn-1" };
  }
  async steerTurn() { throw new Error("unexpected steer"); }
}

const client = new Client();
const state = { offset: 0 };
const runtime = new BridgeRuntime({
  client,
  telegram: { sendText: async () => {} },
  outbox: {},
  state,
  saveState: async () => {},
  archiveMessage: async () => {},
  downloadAttachments: async (record) => {
    if (record.message_id === 90) await new Promise((resolve) => setTimeout(resolve, 20));
    for (const attachment of record.attachments) attachment.local_path = "/data/experts/participant/attachments/90_answer.md";
    return record;
  },
  expectedChat: -100,
  botUsername: "sample_participant_bot",
  deliveryQueue: { enqueue: async () => {} },
  deliveryWorker: { wake: () => {} },
  batchDelayMs: 1,
  expertId: "participant",
});

const message = (updateId, messageId, text, document) => ({
  update_id: updateId,
  message: {
    message_id: messageId,
    date: 1788640796,
    chat: { id: -100 },
    from: { id: 123456, username: "sample_owner" },
    ...(text ? { text } : {}),
    ...(document ? { document } : {}),
  },
});

await runtime.processUpdates([
  message(100, 89, "@sample_participant_bot проверь ответ"),
  message(101, 90, "", { file_id: "file-1", file_unique_id: "unique-1", file_name: "answer.md", mime_type: "text/markdown", file_size: 100 }),
]);
await runtime.flushInputs();

assert.equal(client.calls.length, 1);
assert.match(client.calls[0][0].text, /@sample_participant_bot проверь ответ/);
assert.match(client.calls[0][0].text, /document: \/data\/experts\/participant\/attachments\/90_answer\.md/);
assert.equal(state.offset, 102);

console.log("PASS polling batch keeps addressed text with a separately downloaded following file");
