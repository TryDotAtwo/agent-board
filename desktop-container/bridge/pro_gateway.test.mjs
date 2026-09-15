import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const threadId = "fixed-pro-chat";
const firstId = "a".repeat(64);
const secondId = "b".repeat(64);
const request = (id = firstId, prompt = "first prompt", createdAt = "2026-08-31T00:00:00.000Z") => ({ id, threadId, prompt, createdAt });
const turn = (id, prompt, answer = "answer") => ({ id, status: "completed", items: [
  { type: "userMessage", content: [{ type: "text", text: prompt }] },
  { type: "agentMessage", phase: "final_answer", text: answer },
] });
const silentTurn = (id, prompt) => ({ id, status: "completed", items: [
  { type: "userMessage", content: [{ type: "text", text: prompt }] },
] });
const snapshot = (turns = [], status = "idle", target = threadId) => ({ thread: { id: target, status: { type: status } }, turns });
const mcp = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], isError: false });

async function implementation() {
  try { return (await import("./pro_gateway.mjs")).ProGateway; }
  catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("durable Pro gateway is not implemented"); throw error; }
}
async function fixture(t, initial = snapshot(), options = {}) {
  const ProGateway = await implementation();
  const root = await mkdtemp(path.join(os.tmpdir(), "pro-gateway-test-"));
  await mkdir(path.join(root, "requests"));
  await mkdir(path.join(root, "results"));
  const remote = { snapshot: initial, sends: [], reads: [], factories: 0, closes: 0, readError: null, onSend: null, onRead: null };
  const clientFactory = () => {
    remote.factories++;
    return {
      async start() {},
      async readThread(options) { remote.reads.push(options); await remote.onRead?.(options); if (remote.readError) { const error = remote.readError; remote.readError = null; throw error; } return mcp(remote.snapshot); },
      async sendMessage(prompt) { remote.sends.push(prompt); await remote.onSend?.(prompt); return mcp({ ok: true }); },
      close() { remote.closes++; },
    };
  };
  const gateways = [];
  const create = () => { const gateway = new ProGateway({ root, threadId, clientFactory, ...options }); gateways.push(gateway); return gateway; };
  t.after(async () => { await Promise.all(gateways.map((gateway) => gateway.close())); await rm(root, { recursive: true, force: true }); });
  const put = (value, id = value.id) => writeFile(path.join(root, "requests", `${id}.json`), JSON.stringify(value));
  const ledger = (id = firstId) => readFile(path.join(root, "results", `${id}.json`), "utf8").then(JSON.parse);
  return { root, remote, create, put, ledger };
}

test("send intent and baseline are durable before external send; full answer is later completed exactly once", async (t) => {
  const f = await fixture(t, snapshot([turn("old", "older prompt")]));
  await f.put(request());
  f.remote.onSend = async () => {
    const intent = await f.ledger();
    assert.equal(intent.status, "sending");
    assert.equal(intent.prompt, "first prompt");
    assert.deepEqual(intent.previousTurnIds, ["old"]);
  };
  const gateway = f.create();
  assert.equal((await gateway.tick()).status, "waiting");
  assert.deepEqual(f.remote.sends, ["first prompt"]);
  const answer = "Ω full answer\n".repeat(1000);
  f.remote.snapshot = snapshot([turn("new", "first prompt", answer)]);
  assert.equal((await gateway.tick()).status, "completed");
  assert.equal((await f.ledger()).answer, answer);
  await gateway.tick();
  assert.deepEqual(f.remote.sends, ["first prompt"]);
  assert.deepEqual((await readdir(path.join(f.root, "requests"))), [`${firstId}.json`]);
  assert.equal(JSON.parse(await readFile(path.join(f.root, "heartbeat.json"), "utf8")).status, "running");
});

test("FIFO uses createdAt and does not send next job while a prior answer is active", async (t) => {
  const f = await fixture(t);
  await f.put(request(secondId, "second", "2026-08-31T00:00:02.000Z"));
  await f.put(request());
  const gateway = f.create();
  await gateway.tick();
  f.remote.snapshot = snapshot([turn("new", "first prompt", "partial")], "active");
  await gateway.tick();
  assert.deepEqual(f.remote.sends, ["first prompt"]);
  f.remote.snapshot = snapshot([turn("new", "first prompt", "done")]);
  await gateway.tick();
  assert.deepEqual(f.remote.sends, ["first prompt"]);
  await gateway.tick();
  assert.deepEqual(f.remote.sends, ["first prompt", "second"]);
});

test("completed request survives gateway restart and duplicate request replay without a send", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  const first = f.create();
  await first.tick();
  f.remote.snapshot = snapshot([turn("new", "first prompt")]);
  await first.tick();
  await first.close();
  await f.put(request());
  await f.create().tick();
  assert.deepEqual(f.remote.sends, ["first prompt"]);
  assert.equal((await f.ledger()).status, "completed");
});

test("persisted sending after a crash reconciles exact new turn without transmitting again", async (t) => {
  const f = await fixture(t, snapshot([turn("new", "first prompt", "recovered")]));
  await f.put(request());
  await writeFile(path.join(f.root, "results", `${firstId}.json`), JSON.stringify({ id: firstId, threadId,
    status: "sending", prompt: "first prompt", previousTurnIds: ["old"] }));
  assert.equal((await f.create().tick()).status, "completed");
  assert.equal((await f.ledger()).answer, "recovered");
  assert.deepEqual(f.remote.sends, []);
});

test("a user-only cloud snapshot is not silence even after three minutes; the late answer is retained", async (t) => {
  let now = 1_000_000;
  const f = await fixture(t, snapshot(), { now: () => now, silentGraceMs: 15_000 });
  await f.put(request());
  const gateway = f.create();
  assert.equal((await gateway.tick()).status, "waiting");
  f.remote.snapshot = snapshot([silentTurn("new", "first prompt")]);
  const observed = await gateway.tick();
  assert.equal(observed.status, "waiting");
  now += 180_000;
  assert.equal((await gateway.tick()).status, "waiting");
  f.remote.snapshot = snapshot([turn("new", "first prompt", "late complete answer")]);
  const completed = await gateway.tick();
  assert.equal(completed.answer, "late complete answer");
  assert.equal(Object.hasOwn(completed, "silent"), false);
  assert.deepEqual(f.remote.sends, ["first prompt"]);
});

test("an explicit empty assistant final can become silence after the grace period", async (t) => {
  let now = 2_000_000;
  const f = await fixture(t, snapshot(), { now: () => now, silentGraceMs: 15_000 });
  await f.put(request());
  const gateway = f.create();
  await gateway.tick();
  f.remote.snapshot = snapshot([turn("new", "first prompt", "")]);
  assert.equal((await gateway.tick()).status, "waiting");
  now += 15_000;
  const completed = await gateway.tick();
  assert.equal(completed.status, "completed");
  assert.equal(completed.silent, true);
});

test("ambiguous send blocks FIFO even across restart and never accepts an old equal-prompt reply", async (t) => {
  const f = await fixture(t, snapshot([turn("old", "first prompt", "stale")]));
  await f.put(request());
  await f.put(request(secondId, "second", "2026-08-31T00:00:01.000Z"));
  f.remote.onSend = async () => { throw Object.assign(new Error("secret diagnostic must not be persisted"), { ambiguous: true }); };
  const gateway = f.create();
  assert.equal((await gateway.tick()).status, "blocked");
  assert.doesNotMatch((await f.ledger()).error, /secret/);
  await gateway.close();
  const restarted = f.create();
  await restarted.tick();
  await restarted.tick();
  assert.equal((await f.ledger()).status, "blocked");
  assert.deepEqual(f.remote.sends, ["first prompt"]);
  f.remote.snapshot = snapshot([turn("new", "first prompt", "late reply")]);
  assert.equal((await restarted.tick()).status, "completed");
  assert.equal((await f.ledger()).answer, "late reply");
});

test("read failure reconnects before send and polling failure reconnects without resending", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  const gateway = f.create();
  f.remote.readError = new Error("offline");
  assert.equal((await gateway.tick()).status, "queued");
  assert.deepEqual(f.remote.sends, []);
  await gateway.tick();
  f.remote.readError = new Error("disconnected during response");
  await gateway.tick();
  f.remote.snapshot = snapshot([turn("new", "first prompt")]);
  assert.equal((await gateway.tick()).status, "completed");
  assert.equal(f.remote.factories, 3);
  assert.deepEqual(f.remote.sends, ["first prompt"]);
});

test("fixed target mismatch in remote snapshot fails closed without sending", async (t) => {
  const f = await fixture(t, snapshot([], "idle", "wrong-chat"));
  await f.put(request());
  assert.equal((await f.create().tick()).status, "blocked");
  assert.match((await f.ledger()).error, /TARGET/);
  assert.deepEqual(f.remote.sends, []);
});

for (const [name, changes] of [
  ["wrong target", { threadId: "wrong-chat" }], ["empty prompt", { prompt: "  " }],
  ["oversized prompt", { prompt: "я".repeat(60001) }], ["unknown field", { shell: "no" }],
  ["invalid timestamp", { createdAt: "yesterday" }], ["mismatched identity", { id: secondId }],
]) test(`invalid request: ${name} is recorded blocked without external activity`, async (t) => {
  const f = await fixture(t);
  await f.put({ ...request(), ...changes }, firstId);
  assert.equal((await f.create().tick()).status, "blocked");
  assert.equal((await f.ledger()).status, "blocked");
  assert.deepEqual(f.remote.sends, []);
  assert.equal(f.remote.factories, 0);
});

test("one owner holds the spool lock and graceful close permits the next owner", async (t) => {
  const f = await fixture(t);
  const first = f.create();
  await first.tick();
  const second = f.create();
  await assert.rejects(() => second.tick(), /lock|owner/i);
  await first.close();
  await f.create().tick();
  assert.deepEqual(f.remote.sends, []);
});

test("overlapping ticks cannot submit a second copy", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  const gateway = f.create();
  await Promise.all([gateway.tick(), gateway.tick(), gateway.tick()]);
  assert.deepEqual(f.remote.sends, ["first prompt"]);
});

test("busy existing Chat stays queued without trying native steering", async (t) => {
  const f = await fixture(t, snapshot([], "active"));
  await f.put(request());
  assert.equal((await f.create().tick()).status, "queued");
  assert.deepEqual(f.remote.sends, []);
});

test("an active ledger still blocks later requests even if its original request file disappeared", async (t) => {
  const f = await fixture(t);
  await f.put(request(secondId, "second"));
  await writeFile(path.join(f.root, "results", `${firstId}.json`), JSON.stringify({ id: firstId, threadId,
    status: "sending", prompt: "first prompt", previousTurnIds: [] }));
  await f.create().tick();
  assert.deepEqual(f.remote.sends, []);
  assert.equal((await f.ledger()).status, "blocked");
});

test("conflicting replay identity fails closed and preserves completed ledger", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  await writeFile(path.join(f.root, "results", `${firstId}.json`), JSON.stringify({ id: firstId, threadId,
    status: "completed", prompt: "different original prompt", answer: "old answer", previousTurnIds: [] }));
  await assert.rejects(() => f.create().tick(), /identity|conflict/i);
  assert.equal((await f.ledger()).answer, "old answer");
  assert.deepEqual(f.remote.sends, []);
});

async function runner() {
  try { return (await import("./pro_gateway_runner.mjs")).runProGateway; }
  catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Pro gateway runner is not implemented"); throw error; }
}

test("runner rejects missing inherited Desktop caller identity before opening the spool", async (t) => {
  const run = await runner();
  const f = await fixture(t);
  const env = { PRO_GATEWAY_ROOT: f.root, PRO_CHAT_THREAD_ID: threadId, PRO_DESKTOP_MCP_SERVER: path.join(f.root, "server.mjs") };
  await assert.rejects(() => run({ env, signal: AbortSignal.abort() }), /CODEX_THREAD_ID/);
  await assert.rejects(() => run({ env: { ...env, CODEX_THREAD_ID: "inherited-caller" }, signal: AbortSignal.abort() }), /CODEX_APP_TOOLS_PIPE_PATH/);
  assert.equal((await readdir(f.root)).includes(".pro-gateway.lock"), false);
});

test("runner graceful cancellation writes closed heartbeat and releases exclusive ownership", async (t) => {
  const run = await runner();
  const f = await fixture(t);
  const controller = new AbortController();
  // No request exists, so the genuine Desktop boundary is not invoked here.
  const events = [];
  await run({ env: { PRO_GATEWAY_ROOT: f.root, PRO_CHAT_THREAD_ID: threadId,
    PRO_DESKTOP_MCP_SERVER: path.join(f.root, "unused-server.mjs"), CODEX_THREAD_ID: "test-only-caller",
    CODEX_APP_TOOLS_PIPE_PATH: "test-only-unused-pipe" }, signal: controller.signal,
    log(event) { events.push(JSON.parse(event)); controller.abort(); } });
  const heartbeat = JSON.parse(await readFile(path.join(f.root, "heartbeat.json"), "utf8"));
  assert.equal(heartbeat.status, "closed");
  assert.equal(events[0].event, "pro_gateway_ready");
  assert.equal((await readdir(f.root)).includes(".pro-gateway.lock"), false);
});

test("shutdown during baseline read cannot send after shutdown was requested", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  let release;
  let reading;
  const beganReading = new Promise((resolve) => { reading = resolve; });
  f.remote.onRead = () => { reading(); return new Promise((resolve) => { release = resolve; }); };
  const gateway = f.create();
  const ticking = gateway.tick();
  await beganReading;
  const closing = gateway.close();
  release();
  await Promise.all([ticking, closing]);
  assert.deepEqual(f.remote.sends, []);
  assert.equal((await f.ledger()).status, "queued");
});

test("a stale-owner lock is never deleted automatically", async (t) => {
  const f = await fixture(t);
  const lock = { pid: 2147483647, threadId, token: "dead-owner-operator-must-verify" };
  await writeFile(path.join(f.root, ".pro-gateway.lock"), JSON.stringify(lock));
  await assert.rejects(() => f.create().tick(), /lock|owner/i);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, ".pro-gateway.lock"), "utf8")), lock);
  assert.deepEqual(f.remote.sends, []);
});

test("malformed baseline without stable turn ids is never enough authorization to send", async (t) => {
  const f = await fixture(t, snapshot([{ items: [] }]));
  await f.put(request());
  assert.equal((await f.create().tick()).status, "queued");
  assert.deepEqual(f.remote.sends, []);
});

test("corrupted existing ledger cannot be treated as an unsent request", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  await writeFile(path.join(f.root, "results", `${firstId}.json`), "{partial");
  await assert.rejects(() => f.create().tick());
  assert.deepEqual(f.remote.sends, []);
  assert.equal(await readFile(path.join(f.root, "results", `${firstId}.json`), "utf8"), "{partial");
});

test("calendar-invalid ISO timestamp is rejected rather than silently normalized", async (t) => {
  const f = await fixture(t);
  await f.put(request(firstId, "first prompt", "2026-02-31T00:00:00.000Z"));
  assert.equal((await f.create().tick()).status, "blocked");
  assert.deepEqual(f.remote.sends, []);
});

for (const explicit of [false, true]) test(`truncated final answer completes with visible local failure, never partial text (${explicit ? "explicit marker" : "read limit"})`, async (t) => {
  const f = await fixture(t);
  await f.put(request());
  const gateway = f.create();
  await gateway.tick();
  const partialText = explicit ? "shortened reply" : "x".repeat(20000);
  const answerTurn = turn("new", "first prompt", partialText);
  if (explicit) answerTurn.items[1].truncated = true;
  f.remote.snapshot = snapshot([answerTurn]);
  assert.equal((await gateway.tick()).status, "completed");
  const result = await f.ledger();
  assert.equal(result.error, "ANSWER_POSSIBLY_TRUNCATED");
  assert.match(result.answer, /исходн.*чат.*ChatGPT/);
  assert(!result.answer.includes(partialText));
  assert.deepEqual(f.remote.sends, ["first prompt"]);
});

test("gateway obeys real stock MCP limits instead of repeatedly queuing schema errors", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  f.remote.onRead = (options) => {
    if (options.turnLimit > 10 || options.maxOutputCharsPerItem > 20000) throw Object.assign(new Error(
      "read_thread received invalid arguments: turnLimit: Too big: expected number to be <=10; maxOutputCharsPerItem: Too big: expected number to be <=20000."), { code: "MCP_TOOL_ERROR" });
  };
  assert.equal((await f.create().tick()).status, "waiting");
  assert.deepEqual(f.remote.reads, [{ turnLimit: 10, maxOutputCharsPerItem: 20000 }]);
  assert.deepEqual(f.remote.sends, ["first prompt"]);
});

test("prompt beyond exact-history character budget is rejected before any Desktop call", async (t) => {
  const f = await fixture(t);
  await f.put(request(firstId, "x".repeat(19001)));
  assert.equal((await f.create().tick()).status, "blocked");
  assert.equal(f.remote.factories, 0);
  assert.deepEqual(f.remote.sends, []);
});

test("maximum safe prompt remains unmodified and is matched exactly", async (t) => {
  const f = await fixture(t);
  const prompt = "я".repeat(19000);
  await f.put(request(firstId, prompt));
  const gateway = f.create();
  await gateway.tick();
  f.remote.snapshot = snapshot([turn("new", prompt, "complete reply")]);
  assert.equal((await gateway.tick()).answer, "complete reply");
  assert.deepEqual(f.remote.sends, [prompt]);
});

test("oversized baseline history is refused without sending", async (t) => {
  const f = await fixture(t, snapshot(Array.from({ length: 11 }, (_, index) => turn(`old-${index}`, "older prompt"))));
  await f.put(request());
  assert.equal((await f.create().tick()).status, "queued");
  assert.deepEqual(f.remote.sends, []);
});

test("persisted baseline above advertised history maximum fails closed", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  await writeFile(path.join(f.root, "results", `${firstId}.json`), JSON.stringify({ id: firstId, threadId,
    status: "sending", prompt: "first prompt", previousTurnIds: Array.from({ length: 11 }, (_, index) => `old-${index}`) }));
  await assert.rejects(() => f.create().tick(), /invalid ledger/);
  assert.deepEqual(f.remote.sends, []);
});

test("active truncated response stays waiting and visible failure only completes once Chat is idle", async (t) => {
  const f = await fixture(t);
  await f.put(request());
  await f.put(request(secondId, "next prompt", "2026-08-31T00:00:02.000Z"));
  const gateway = f.create();
  await gateway.tick();
  const candidate = turn("new", "first prompt", "truncated partial reply");
  candidate.items[1].truncated = true;
  f.remote.snapshot = snapshot([candidate], "active");
  assert.equal((await gateway.tick()).status, "waiting");
  assert.deepEqual(f.remote.sends, ["first prompt"]);
  f.remote.snapshot = snapshot([candidate]);
  assert.equal((await gateway.tick()).status, "completed");
  await gateway.tick();
  assert.deepEqual(f.remote.sends, ["first prompt", "next prompt"]);
});

test("truncation on unrelated history cannot complete an uncertain request", async (t) => {
  const f = await fixture(t, snapshot([turn("old", "older prompt")]));
  await f.put(request());
  const gateway = f.create();
  await gateway.tick();
  f.remote.snapshot.truncated = true;
  assert.equal((await gateway.tick()).status, "waiting");
  assert.deepEqual(f.remote.sends, ["first prompt"]);
});
