import { classifyArtifact, PermanentTelegramError } from "./telegram_output.mjs";
import { sanitizeDeliveryError } from "./delivery_queue.mjs";

const BACKOFF = [1000, 2000, 5000, 15000, 30000, 60000];

export class DeliveryWorker {
  constructor({ queue, client, recordDelivery = async () => {}, now = () => Date.now(),
    setTimer = setTimeout, clearTimer = clearTimeout, log = async () => {} }) {
    Object.assign(this, { queue, client, recordDelivery, now, setTimer, clearTimer, log });
    this.stopped = true;
  }

  async start() {
    this.stopped = false;
    const jobs = await this.queue.list();
    const due = jobs.filter((job) => job.status === "pending" && job.nextAttemptAt <= this.now()).length;
    const delayed = jobs.filter((job) => job.status === "pending" && job.nextAttemptAt > this.now()).length;
    const blocked = jobs.filter((job) => job.status === "blocked").length;
    await this.log(`delivery queue started: due=${due} delayed=${delayed} blocked=${blocked}`);
    this.wake();
  }

  stop() { this.stopped = true; if (this.timer) this.clearTimer(this.timer); this.timer = undefined; }

  wake() {
    if (this.stopped) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = undefined; this.drainDue().catch((error) => this.log(`delivery worker error: ${sanitizeDeliveryError(error.message)}`)); }, 0);
  }

  async drainDue() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#drain();
    try { await this.inFlight; }
    finally { this.inFlight = undefined; if (!this.stopped) await this.#scheduleNext(); }
  }

  async #drain() {
    const jobs = await this.queue.list();
    for (let job of jobs) {
      if (job.status !== "pending" || job.nextAttemptAt > this.now()) continue;
      const age = this.now() - Date.parse(job.createdAt);
      if (age >= 300000 && !job.staleWarnedAt) {
        await this.log(`stale delivery turn=${job.turnId} ageMs=${age}`);
        job = await this.queue.advance(job.turnId, { staleWarnedAt: this.now() });
      }
      await this.#deliver(job);
    }
  }

  async #deliver(initial) {
    let job = initial;
    try {
      while (job.nextTextIndex < job.textChunks.length) {
        const index = job.nextTextIndex;
        await this.client.sendText({ chatId: job.chatId, text: job.textChunks[index], replyTo: index === 0 ? job.replyTo : undefined,
          ...(job.topicId ? { topicId: job.topicId } : {}) });
        job = await this.queue.advance(job.turnId, { nextTextIndex: index + 1, attempt: 0, nextAttemptAt: 0, lastError: undefined });
      }
      while (job.nextArtifactIndex < job.artifacts.length) {
        const index = job.nextArtifactIndex;
        const artifact = job.artifacts[index];
        const method = classifyArtifact(artifact) === "photo" ? "sendPhoto" : "sendDocument";
        await this.client[method]({ chatId: job.chatId, artifact,
          ...(job.topicId ? { topicId: job.topicId } : {}),
          replyTo: job.textChunks.length === 0 && index === 0 ? job.replyTo : undefined });
        job = await this.queue.advance(job.turnId, { nextArtifactIndex: index + 1, attempt: 0, nextAttemptAt: 0, lastError: undefined });
        try { await this.recordDelivery(artifact.artifactId, "delivered"); }
        catch (error) { await this.log(`artifact delivery ack failed turn=${job.turnId} index=${index}: ${sanitizeDeliveryError(error.message)}`); }
      }
      await this.queue.complete(job.turnId);
      await this.log(`delivery completed turn=${job.turnId}`);
    } catch (error) {
      if (error instanceof PermanentTelegramError) {
        await this.queue.block(job.turnId, error.message);
        await this.log(`delivery blocked turn=${job.turnId}: ${sanitizeDeliveryError(error.message)}`);
        return;
      }
      const attempt = (job.attempt || 0) + 1;
      const delay = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
      await this.queue.advance(job.turnId, { attempt, nextAttemptAt: this.now() + delay, lastError: sanitizeDeliveryError(error.message) });
      await this.log(`delivery retry turn=${job.turnId} attempt=${attempt} delayMs=${delay}: ${sanitizeDeliveryError(error.message)}`);
    }
  }

  async #scheduleNext() {
    if (this.stopped) return;
    const pending = (await this.queue.list()).filter((job) => job.status === "pending");
    if (!pending.length) return;
    const delay = Math.max(0, Math.min(...pending.map((job) => job.nextAttemptAt || 0)) - this.now());
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = undefined; this.drainDue().catch((error) => this.log(`delivery worker error: ${sanitizeDeliveryError(error.message)}`)); }, delay);
  }
}
