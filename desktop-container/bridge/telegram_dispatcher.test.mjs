import assert from "node:assert/strict";
import { TelegramDispatcher } from "./telegram_dispatcher.mjs";

class FakeClient {
  constructor() { this.calls = []; this.active = new Map(); }
  getActiveTurnId(id) { return this.active.get(id); }
  async startTurn(expertId, input) {
    this.calls.push({ method: "start", input });
    this.active.set(expertId, `turn_${this.calls.length}`);
    return { id: this.active.get(expertId) };
  }
  async steerTurn(expertId, input) {
    this.calls.push({ method: "steer", input });
    if (this.failSteer) { this.active.delete(expertId); throw new Error("No active turn"); }
    return { turnId: this.active.get(expertId) };
  }
}

function record(text, addressed = true, attachments = []) {
  return { message_id: Math.random(), sender: "alice", text, addressed, attachments };
}

const client = new FakeClient();
const dispatcher = new TelegramDispatcher({ client, expertId: "alpha" });
assert.equal(await dispatcher.dispatch(record("chat noise", false)), "ignored");
assert.equal(client.calls.length, 0);

assert.equal(await dispatcher.dispatch(record("first")), "started");
assert.equal(client.calls[0].method, "start");
assert.match(client.calls[0].input[0].text, /alice: first/);

assert.equal(await dispatcher.dispatch(record("second", true, [
  { kind: "photo", local_path: "/data/attachments/p.png", mime_type: "image/png" },
  { kind: "document", local_path: "/data/attachments/n.ipynb", mime_type: "application/json" },
])), "steered");
assert.equal(client.calls[1].method, "steer");
assert.deepEqual(client.calls[1].input[1], { type: "localImage", path: "/data/attachments/p.png" });
assert.match(client.calls[1].input[0].text, /n\.ipynb/);

await Promise.all([dispatcher.dispatch(record("third")), dispatcher.dispatch(record("fourth"))]);
assert.match(client.calls[2].input[0].text, /third/);
assert.match(client.calls[3].input[0].text, /fourth/);

client.failSteer = true;
assert.equal(await dispatcher.dispatch(record("race")), "started");
assert.equal(client.calls.at(-1).method, "start");
assert.match(client.calls.at(-1).input[0].text, /race/);

const proClient = new FakeClient();
proClient.supportsAttachments = false;
const proDispatcher = new TelegramDispatcher({ client: proClient, expertId: "pro",
  readTextAttachment: async () => "# Проверяемый ответ\n\nСодержимое файла." });
await proDispatcher.dispatch(record("проверь ответ", true, [
  { kind: "document", local_path: "/data/experts/frontier_pro/attachments/90_answer.md",
    file_name: "answer.md", mime_type: "text/markdown", file_size: 100 },
]));
assert.equal(proClient.calls.length, 1);
assert.match(proClient.calls[0].input[0].text, /Содержимое вложения answer\.md/);
assert.match(proClient.calls[0].input[0].text, /# Проверяемый ответ/);
assert.doesNotMatch(proClient.calls[0].input[0].text, /Вложения доступны только на чтение/);
assert.equal(proClient.calls[0].input.length, 1);

const codexClient = new FakeClient();
codexClient.supportsAttachments = true;
const codexDispatcher = new TelegramDispatcher({ client: codexClient, expertId: "codex",
  readTextAttachment: async () => "Проверяемый текст для Codex." });
await codexDispatcher.dispatch(record("проверь файл", true, [
  { kind: "document", local_path: "/data/experts/sol_ultra/attachments/90_answer.md",
    file_name: "answer.md", mime_type: "text/markdown", file_size: 100 },
]));
assert.match(codexClient.calls[0].input[0].text, /Проверяемый текст для Codex/,
  "small text documents must be inlined even when the Codex client can access local paths");
assert.equal(codexClient.calls[0].input.length, 1);

console.log("PASS addressed dispatch, ordered native steering, images, documents, and completion race");
