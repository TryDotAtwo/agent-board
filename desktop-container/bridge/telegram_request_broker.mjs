import { randomUUID } from "node:crypto";
import { TelegramAnswerCollector } from "./telegram_answer_collector.mjs";

export class TelegramRequestBroker {
  constructor({ telegram, chatId, experts, attachmentStore, silenceMs = 2000, now = Date.now }) {
    Object.assign(this, { telegram, chatId, attachmentStore, silenceMs, now });
    this.experts = new Map(experts.map((expert) => [expert.id, { ...expert, botId: Number(expert.botId) }]));
    this.queue = [];
    this.locked = new Set();
    this.active = new Set();
    this.scheduling = Promise.resolve();
  }

  async ask({ experts, question, timeoutSeconds = 300 }) {
    const targets = Array.isArray(experts) ? experts.map(String) : [];
    if (!targets.length) throw new Error("at least one expert is required");
    if (new Set(targets).size !== targets.length) throw new Error("duplicate expert target");
    for (const id of targets) if (!this.experts.has(id)) throw new Error(`unknown expert: ${id}`);
    const text = String(question || "").trim();
    if (!text || text.length > 12000) throw new Error("question length is invalid");
    const timeout = Number(timeoutSeconds);
    if (!Number.isFinite(timeout) || timeout < 5 || timeout > 900) throw new Error("timeout must be between 5 and 900 seconds");
    return new Promise((resolve, reject) => {
      this.queue.push({ requestId: randomUUID(), targets, question: text, timeoutSeconds: timeout, resolve, reject });
      this.#schedule();
    });
  }

  acceptUpdate(update) {
    const message = update?.edited_message || update?.message;
    if (!message || Number(message.chat?.id) !== Number(this.chatId)) return "ignored";
    let accepted = false;
    for (const job of this.active) accepted = job.collector.accept(update) !== "ignored" || accepted;
    return accepted ? "accepted" : "ignored";
  }

  async tick() {
    const current = this.now();
    for (const job of [...this.active]) {
      if (current >= job.deadline) job.collector.timeout();
      else job.collector.finish();
      const finished = [...Object.values(job.collector.result())].every((answer) => ["answered", "timeout"].includes(answer.status));
      if (finished) await this.#finalize(job);
    }
  }

  #schedule() {
    this.scheduling = this.scheduling.then(async () => {
      for (let index = 0; index < this.queue.length;) {
        const job = this.queue[index];
        if (job.targets.some((id) => this.locked.has(id))) { index += 1; continue; }
        this.queue.splice(index, 1);
        for (const id of job.targets) this.locked.add(id);
        void this.#start(job);
      }
    });
  }

  async #start(job) {
    try {
      const selected = job.targets.map((id) => this.experts.get(id));
      const text = `${selected.map((expert) => `@${String(expert.username).replace(/^@/, "")}`).join(" ")}\n\n${job.question}`;
      const sent = await this.telegram.sendText({ chatId: this.chatId, text });
      job.messageId = sent.message_id;
      job.deadline = this.now() + job.timeoutSeconds * 1000;
      job.collector = new TelegramAnswerCollector({ requestMessageId: job.messageId, experts: selected, silenceMs: this.silenceMs, now: this.now });
      this.active.add(job);
    } catch (error) {
      this.#release(job);
      job.reject(error);
    }
  }

  async #finalize(job) {
    this.active.delete(job);
    const answers = job.collector.result();
    for (const [expertId, answer] of Object.entries(answers)) {
      if (answer.attachments.length) answer.attachments = await this.attachmentStore.save(job.requestId, expertId, answer.attachments);
    }
    this.#release(job);
    job.resolve({ requestId: job.requestId, messageId: job.messageId, answers });
  }

  #release(job) {
    this.active.delete(job);
    for (const id of job.targets) this.locked.delete(id);
    this.#schedule();
  }
}
