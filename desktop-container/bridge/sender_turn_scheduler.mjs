function senderKey(record) {
  if (record?.sender_id == null) throw new Error("Telegram sender_id is required");
  return record.message_thread_id == null ? String(record.sender_id)
    : `${record.chat_id}:${record.message_thread_id}:${record.sender_id}`;
}

function combineRecords(records) {
  const ordered = [...records].sort((a, b) => a.message_id - b.message_id);
  const ids = ordered.flatMap((item) => item.message_ids || [item.message_id]);
  return {
    ...ordered.at(-1),
    message_ids: [...new Set(ids)],
    text: ordered.map((item) => String(item.text || "").trim()).filter(Boolean).join("\n\n"),
    attachments: ordered.flatMap((item) => item.attachments || []),
  };
}

function mergeEntry(entry, incoming) {
  entry.parts ||= [entry.record];
  const index = entry.parts.findIndex((part) => part.message_id === incoming.message_id);
  if (incoming.is_correction && index >= 0) entry.parts[index] = incoming;
  else entry.parts.push(incoming);
  entry.record = combineRecords(entry.parts);
  return incoming.is_correction && index >= 0 ? "updated" : "merged";
}

export class SenderTurnScheduler {
  constructor({ state, saveState, dispatch, allowSteer = true }) {
    Object.assign(this, { state, saveState, dispatch, allowSteer });
    this.state.senderScheduler ||= { active: null, waiting: [] };
    this.chain = Promise.resolve();
  }

  accept(record) { return this.#serial(() => this.#accept(record)); }
  complete(turnId) { return this.#serial(() => this.#complete(turnId)); }
  restore() { return this.#serial(() => this.#restore()); }

  #serial(operation) {
    const result = this.chain.then(operation);
    this.chain = result.catch(() => {});
    return result;
  }

  async #accept(record) {
    const senderId = senderKey(record);
    const data = this.state.senderScheduler;
    if (!data.active) return this.#start({ senderId, record });
    if (this.allowSteer && data.active.senderId === senderId) {
      const outcome = await this.dispatch(record);
      return outcome.result;
    }
    const waiting = data.waiting.find((item) => item.senderId === senderId);
    if (waiting) {
      const result = mergeEntry(waiting, record);
      await this.saveState(this.state);
      return result;
    }
    data.waiting.push({ senderId, record, parts: [record] });
    await this.saveState(this.state);
    return "queued";
  }

  async #complete(turnId) {
    const data = this.state.senderScheduler;
    if (!data.active || (turnId && data.active.turnId !== turnId)) return "ignored";
    data.active = null;
    await this.saveState(this.state);
    const next = data.waiting[0];
    if (!next) return "idle";
    return this.#startWaiting(next);
  }

  async #restore() {
    const data = this.state.senderScheduler;
    if (data.active) data.waiting.unshift({ senderId: data.active.senderId, record: data.active.record });
    data.active = null;
    await this.saveState(this.state);
    const next = data.waiting[0];
    if (!next) return "idle";
    return this.#startWaiting(next);
  }

  async #startWaiting(entry) {
    if (!this.allowSteer) {
      const waiting = this.state.senderScheduler.waiting;
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      return this.#start(entry);
    }
    const outcome = await this.dispatch(entry.record);
    const waiting = this.state.senderScheduler.waiting;
    const index = waiting.indexOf(entry);
    if (index >= 0) waiting.splice(index, 1);
    this.state.senderScheduler.active = { ...entry, turnId: outcome.turnId };
    await this.saveState(this.state);
    return outcome.result;
  }

  async #start(entry) {
    if (!this.allowSteer) {
      // Preserve sender and Telegram destination before a durable Pro request
      // becomes visible to the Windows relay. Restore safely reattaches by ID.
      this.state.senderScheduler.active = { ...entry, turnId: null };
      await this.saveState(this.state);
    }
    const outcome = await this.dispatch(entry.record);
    this.state.senderScheduler.active = { ...entry, turnId: outcome.turnId };
    await this.saveState(this.state);
    return outcome.result;
  }
}
