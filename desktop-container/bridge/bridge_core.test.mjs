import assert from "node:assert/strict";

const core = await import("./bridge_core.mjs").catch(() => ({}));

assert.equal(typeof core.telegramRecord, "function", "telegramRecord must exist");
assert.deepEqual(core.telegramRecord({
  message_id: 42,
  date: 123,
  from: { id: 7, username: "alice" },
  chat: { id: -10 },
  caption: "see attachment",
  reply_to_message: { message_id: 40 },
  document: { file_id: "f1", file_unique_id: "u1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 99 },
}), {
  message_id: 42, date: 123, chat_id: -10, sender_id: 7, sender: "alice",
  edit_date: undefined, event_type: "message", media_group_id: undefined,
  text: "see attachment", reply_to_message_id: 40,
  attachments: [{ kind: "document", file_id: "f1", file_unique_id: "u1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 99 }],
});

assert.equal(typeof core.codexInvocation, "function", "codexInvocation must exist");
const first = core.codexInvocation({ images: ["/data/attachments/a.png"] });
assert.ok(first.includes("--json"));
assert.ok(!first.includes("--ephemeral"));
assert.deepEqual(first.slice(-3), ["--image", "/data/attachments/a.png", "-"]);
const resumed = core.codexInvocation({ sessionId: "11111111-1111-1111-1111-111111111111", images: [] });
assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", "--json"]);
assert.equal(resumed.at(-2), "11111111-1111-1111-1111-111111111111");
assert.equal(resumed.at(-1), "-");

assert.equal(typeof core.parseCodexJson, "function", "parseCodexJson must exist");
assert.deepEqual(core.parseCodexJson([
  JSON.stringify({ type: "thread.started", thread_id: "abc" }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
].join("\n")), { sessionId: "abc", answer: "answer" });

console.log("PASS persistent Codex invocation, Telegram record, and JSON event parsing");

assert.equal(core.TELEGRAM_DOWNLOAD_LIMIT, 20 * 1024 * 1024);
assert.equal(typeof core.splitTelegramText, "function", "splitTelegramText must exist");
assert.deepEqual(core.splitTelegramText("a".repeat(5000), 3800).map((part) => part.length), [3800, 1200]);
assert.ok(core.splitTelegramText("a".repeat(9000), 3800).every((part) => part.length <= 3800));

assert.equal(typeof core.formatRecentHistory, "function", "formatRecentHistory must exist");
const recent = core.formatRecentHistory([
  { sender: "alice", text: "first half" },
  { sender: "bob", text: "second half" },
]);
assert.match(recent, /alice: first half/);
assert.match(recent, /bob: second half/);

assert.equal(core.attachmentDownloadError({ file_size: 20 * 1024 * 1024 }), undefined);
assert.match(core.attachmentDownloadError({ file_size: 20 * 1024 * 1024 + 1 }), /20 MiB/);
assert.equal(core.isAddressedMessage({ text: "@sample_participant_bot help" }, "sample_participant_bot"), true);
assert.equal(core.isAddressedMessage({ text: "ordinary chat" }, "sample_participant_bot"), false);
assert.equal(core.isAddressedMessage({ reply_to_message: { from: { username: "sample_participant_bot" } } }, "sample_participant_bot"), true);

const edited = core.telegramRecord({
  message_id: 77, edit_date: 456, media_group_id: "g1", chat: { id: -10 },
  from: { id: 7, username: "alice" }, text: "fixed",
}, "edited_message");
assert.equal(edited.event_type, "edited_message");
assert.equal(edited.edit_date, 456);
assert.equal(edited.media_group_id, "g1");
console.log("PASS Telegram limits and multipart context");
