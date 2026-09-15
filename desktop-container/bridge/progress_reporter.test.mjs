import assert from "node:assert/strict";
import { ProgressReporter } from "./progress_reporter.mjs";

class Clock {
  constructor() { this.now = 0; this.jobs = []; }
  setTimeout = (fn, delay) => { const job = { at: this.now + delay, fn, active: true }; this.jobs.push(job); return job; };
  clearTimeout = (job) => { if (job) job.active = false; };
  async tick(ms) { this.now += ms; for (const job of this.jobs.filter((x) => x.active && x.at <= this.now)) { job.active = false; await job.fn(); } }
}

const clock = new Clock();
const sent = [];
const reporter = new ProgressReporter({ sendStatus: async (text) => sent.push(text), setTimer: clock.setTimeout, clearTimer: clock.clearTimeout });
reporter.turnStarted("t1");
reporter.observe({ type: "commentary", text: "Смотрю dispatcher и тесты" });
await clock.tick(119999);
assert.deepEqual(sent, []);
await clock.tick(1);
assert.deepEqual(sent, ["Статус: Смотрю dispatcher и тесты"]);
reporter.observe({ type: "commentary", text: "Смотрю dispatcher и тесты" });
await clock.tick(120000);
assert.equal(sent.length, 1);
reporter.observe({ type: "activity", tool: "browser" });
await clock.tick(120000);
assert.equal(sent.at(-1), "Статус: проверяю страницу в браузере");
reporter.observe({ type: "reasoning", text: "секретная цепочка" });
await clock.tick(120000);
assert.equal(sent.length, 2);
reporter.observe({ type: "activity", tool: "shell" });
reporter.turnCompleted("t1");
await clock.tick(120000);
assert.equal(sent.length, 2);
console.log("PASS two-minute safe progress throttling and completion cancellation");
