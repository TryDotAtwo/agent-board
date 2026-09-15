const INTERVAL_MS = 120_000;

function safeStatus(event) {
  if (!event || event.type === "reasoning") return undefined;
  if (event.type === "commentary" && event.text) {
    const text = String(event.text).replace(/\s+/g, " ").trim().slice(0, 500);
    return text ? `Статус: ${text}` : undefined;
  }
  if (event.type === "plan" && event.step) return `Статус: ${String(event.step).replace(/\s+/g, " ").trim().slice(0, 400)}`;
  const tool = String(event.tool || "").toLowerCase();
  if (tool.includes("browser") || tool.includes("playwright")) return "Статус: проверяю страницу в браузере";
  if (tool.includes("shell") || tool.includes("exec") || tool.includes("command")) return "Статус: изучаю файлы проекта";
  return undefined;
}

export class ProgressReporter {
  constructor({ sendStatus, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = INTERVAL_MS }) {
    this.sendStatus = sendStatus;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.intervalMs = intervalMs;
  }

  turnStarted(turnId) { this.turnCompleted(); this.turnId = turnId; }

  observe(event) {
    if (!this.turnId) return;
    const status = safeStatus(event);
    if (!status || status === this.lastSent) return;
    this.pending = status;
    if (!this.timer) this.timer = this.setTimer(() => this.flush(), this.intervalMs);
  }

  async flush() {
    this.timer = undefined;
    if (!this.turnId || !this.pending || this.pending === this.lastSent) return;
    const status = this.pending;
    this.pending = undefined;
    await this.sendStatus(status);
    this.lastSent = status;
    if (this.pending && this.pending !== this.lastSent) this.timer = this.setTimer(() => this.flush(), this.intervalMs);
  }

  turnCompleted(turnId) {
    if (turnId && this.turnId && turnId !== this.turnId) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined; this.turnId = undefined; this.pending = undefined; this.lastSent = undefined;
  }
}

export { safeStatus };
