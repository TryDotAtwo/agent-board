function keyFor(record) {
  return `${record.chat_id}:${record.message_thread_id || 0}:${record.sender_id || record.sender}`;
}

function combine(records) {
  const ordered = [...records].sort((a, b) => a.message_id - b.message_id);
  const addressed = ordered.some((item) => item.addressed);
  const text = ordered.map((item) => String(item.text || "").trim()).filter(Boolean).join("\n\n");
  return {
    ...ordered.at(-1),
    text,
    addressed,
    attachments: ordered.flatMap((item) => item.attachments || []),
    message_ids: ordered.map((item) => item.message_id),
  };
}

export class TelegramInputBuffer {
  constructor({ deliver, delayMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { deliver, delayMs, setTimer, clearTimer });
    this.pending = new Map();
    this.deliveredAddressed = new Set();
  }

  async accept(record) {
    const key = keyFor(record);
    const pending = this.pending.get(key);
    if (record.event_type === "edited_message") {
      const index = pending?.records.findIndex((item) => item.message_id === record.message_id) ?? -1;
      if (index >= 0) {
        pending.records[index] = record;
        pending.addressed ||= record.addressed;
        this.#reschedule(key, pending);
        return "updated";
      }
      if (this.deliveredAddressed.has(record.message_id) || record.addressed) {
        await this.deliver({ ...record, addressed: true, is_correction: true,
          message_ids: [record.message_id],
          text: `Пользователь отредактировал сообщение Telegram #${record.message_id}.\nНовая полная версия:\n\n${record.text || "[без текста]"}` });
        return "corrected";
      }
      return "ignored";
    }

    const batch = pending || { records: [], addressed: false, timer: undefined };
    batch.records.push(record);
    batch.addressed ||= record.addressed;
    this.pending.set(key, batch);
    this.#reschedule(key, batch);
    return "buffered";
  }

  async flushAll() {
    for (const key of [...this.pending.keys()]) await this.#flush(key);
  }

  #reschedule(key, batch) {
    this.clearTimer(batch.timer);
    batch.timer = this.setTimer(() => this.#flush(key), this.delayMs);
  }

  async #flush(key) {
    const batch = this.pending.get(key);
    if (!batch) return;
    this.pending.delete(key);
    this.clearTimer(batch.timer);
    if (!batch.addressed) return;
    const combined = combine(batch.records);
    for (const id of combined.message_ids) this.deliveredAddressed.add(id);
    await this.deliver(combined);
  }
}
