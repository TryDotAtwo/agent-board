import assert from "node:assert/strict";
import { TelegramInputBuffer } from "./telegram_input_buffer.mjs";

class Clock {
  constructor() { this.jobs = []; }
  setTimeout = (fn) => { const job = { fn, active: true }; this.jobs.push(job); return job; };
  clearTimeout = (job) => { if (job) job.active = false; };
  async flush() {
    const jobs = this.jobs.splice(0);
    for (const job of jobs) if (job.active) await job.fn();
  }
}

const record = (id, text, extra = {}) => ({
  message_id: id, chat_id: -100, sender_id: 7, sender: "alice", text,
  addressed: true, attachments: [], event_type: "message", ...extra,
});

{
  const clock = new Clock(); const delivered = [];
  const buffer = new TelegramInputBuffer({ deliver: async (item) => delivered.push(item),
    setTimer: clock.setTimeout, clearTimer: clock.clearTimeout });
  await buffer.accept(record(1, "первая часть"));
  await buffer.accept(record(2, "вторая часть"));
  assert.equal(delivered.length, 0);
  await clock.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, "первая часть\n\nвторая часть");
  assert.deepEqual(delivered[0].message_ids, [1, 2]);
}

{
  const clock = new Clock(); const delivered = [];
  const buffer = new TelegramInputBuffer({ deliver: async (item) => delivered.push(item),
    setTimer: clock.setTimeout, clearTimer: clock.clearTimeout });
  await buffer.accept(record(10, "caption", { media_group_id: "album", attachments: [{ kind: "photo", local_path: "/a.jpg" }] }));
  await buffer.accept(record(11, "", { media_group_id: "album", addressed: false, attachments: [{ kind: "photo", local_path: "/b.jpg" }] }));
  await clock.flush();
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].attachments.map((x) => x.local_path), ["/a.jpg", "/b.jpg"]);
}

{
  const clock = new Clock(); const delivered = [];
  const buffer = new TelegramInputBuffer({ deliver: async (item) => delivered.push(item),
    setTimer: clock.setTimeout, clearTimer: clock.clearTimeout });
  await buffer.accept(record(20, "ошибка"));
  await buffer.accept(record(20, "исправлено", { event_type: "edited_message" }));
  await clock.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, "исправлено");
  await buffer.accept(record(20, "финальная версия", { event_type: "edited_message" }));
  assert.equal(delivered.length, 2);
  assert.match(delivered[1].text, /Telegram #20/);
  assert.match(delivered[1].text, /финальная версия/);
  assert.equal(delivered[1].is_correction, true);
}

console.log("PASS rapid input batching, media groups, and Telegram edits");
