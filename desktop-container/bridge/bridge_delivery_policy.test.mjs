import assert from "node:assert/strict";
import test from "node:test";
import { prepareFinalDelivery } from "./bridge_runtime.mjs";

test("answers spanning at most two Telegram messages stay inline", async () => {
  const created = [];
  const outbox = { async createArtifact(input) { created.push(input); return input; } };
  const result = await prepareFinalDelivery({ text: "x".repeat(7000), turnId: "turn-1", outbox });
  assert.equal(result.textChunks.length, 2);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(created, []);
});

test("answers longer than two Telegram messages become one Markdown artifact", async () => {
  const created = [];
  const artifact = { artifactId: "answer", path: "/data/outbox/turns/turn-2/answer.md", mimeType: "text/markdown", size: 9000 };
  const outbox = { async createArtifact(input) { created.push(input); return artifact; } };
  const text = "x".repeat(9000);
  const result = await prepareFinalDelivery({ text, turnId: "turn-2", outbox });
  assert.deepEqual(result.textChunks, []);
  assert.deepEqual(result.artifacts, [artifact]);
  assert.deepEqual(created, [{ relativePath: "answer.md", content: text, turnId: "turn-2", caption: "Полный ответ эксперта" }]);
});
