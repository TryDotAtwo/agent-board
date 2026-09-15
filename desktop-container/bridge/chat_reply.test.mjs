import assert from "node:assert/strict";
import test from "node:test";

async function implementation() {
  try { return (await import("./chat_reply.mjs")).selectCompletedChatReply; }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("correlated completed Chat reply selection is not implemented");
    throw error;
  }
}

const request = { targetThreadId: "chat-target", requestPrompt: "request attempt-123", previousTurnIds: ["old-turn"] };
const snapshot = ({ id = "new-turn", prompt = "request attempt-123", answer = "fresh reply", status = "idle", phase = "final_answer" } = {}) => ({
  thread: { id: "chat-target", status: { type: status } },
  turns: [{ id, status: "completed", items: [
    { type: "userMessage", content: [{ type: "text", text: prompt }] },
    { type: "agentMessage", text: answer, phase },
  ] }],
});

test("a stale idle reply with the same prompt is excluded by the baseline turn ids", async () => {
  const select = await implementation();
  assert.equal(select(snapshot({ id: "old-turn" }), request), null);
});

test("an active thread cannot complete even when its synthetic turn says completed", async () => {
  const select = await implementation();
  assert.equal(select(snapshot({ status: "active" }), request), null);
});

test("an empty or commentary-only reply is not a completed final answer", async () => {
  const select = await implementation();
  assert.equal(select(snapshot({ answer: "   \n" }), request), null);
  assert.equal(select(snapshot({ phase: "commentary" }), request), null);
});

test("a wrong target fails closed rather than polling or accepting its answer", async () => {
  const select = await implementation();
  const wrong = snapshot();
  wrong.thread.id = "other-chat";
  assert.throws(() => select(wrong, request), /target|thread/);
});

test("a new exact-prompt completed reply preserves the entire long text", async () => {
  const select = await implementation();
  const answer = `BEGIN\n${"Complete Ω answer line\n".repeat(10000)}END_LONG_PRO`;
  assert.equal(select(snapshot({ answer }), request), answer);
});

test("a new turn with a different or only partially matching user prompt is not accepted", async () => {
  const select = await implementation();
  assert.equal(select(snapshot({ prompt: "request attempt-other" }), request), null);
  const extraText = snapshot();
  extraText.turns[0].items[0].content.push({ type: "text", text: "additional instructions" });
  assert.equal(select(extraText, request), null);
});

test("missing turns or missing stable turn identity remain not ready", async () => {
  const select = await implementation();
  assert.equal(select({ thread: { id: "chat-target", status: { type: "idle" } }, turns: [] }, request), null);
  const missingId = snapshot();
  delete missingId.turns[0].id;
  assert.equal(select(missingId, request), null);
});

test("read-only mode can return an existing completed long reply without a send baseline", async () => {
  const select = await implementation();
  const answer = `${"read existing answer\n".repeat(1000)}END_LONG_PRO`;
  assert.equal(select(snapshot({ id: "old-turn", prompt: "older prompt", answer }), {
    targetThreadId: "chat-target", requestPrompt: null, previousTurnIds: ["old-turn"],
  }), answer);
});
