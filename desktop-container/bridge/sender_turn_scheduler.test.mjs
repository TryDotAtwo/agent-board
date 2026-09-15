import assert from "node:assert/strict";
import { SenderTurnScheduler } from "./sender_turn_scheduler.mjs";

const state = {};
const calls = [];
let turn = 0;
const scheduler = new SenderTurnScheduler({
  state,
  saveState: async () => {},
  dispatch: async (record) => {
    calls.push({ sender: record.sender_id, text: record.text });
    return { result: turn ? "steered" : "started", turnId: turn ? `turn-${turn}` : `turn-${++turn}` };
  },
});

assert.equal(await scheduler.accept({ sender_id: 10, chat_id: -1, message_id: 1, message_ids: [1], text: "a", attachments: [] }), "started");
assert.equal(await scheduler.accept({ sender_id: 10, chat_id: -1, message_id: 2, message_ids: [2], text: "a2", attachments: [] }), "steered");
assert.equal(await scheduler.accept({ sender_id: 20, chat_id: -1, message_id: 3, message_ids: [3], text: "b", attachments: [] }), "queued");
assert.equal(await scheduler.accept({ sender_id: 30, chat_id: -1, message_id: 4, message_ids: [4], text: "c", attachments: [] }), "queued");
assert.equal(await scheduler.accept({ sender_id: 20, chat_id: -1, message_id: 5, message_ids: [5], text: "b2", attachments: [] }), "merged");
assert.equal(await scheduler.accept({ sender_id: 30, chat_id: -1, message_id: 4, message_ids: [4], text: "c corrected", attachments: [], is_correction: true }), "updated");
assert.deepEqual(calls.map((item) => item.sender), [10, 10]);
assert.deepEqual(state.senderScheduler.waiting.map((item) => item.senderId), ["20", "30"]);
assert.equal(state.senderScheduler.waiting[0].record.text, "b\n\nb2");
assert.equal(state.senderScheduler.waiting[1].record.text, "c corrected");

turn = 0;
await scheduler.complete("turn-1");
assert.deepEqual(calls.map((item) => item.sender), [10, 10, 20]);
assert.equal(state.senderScheduler.active.senderId, "20");
assert.equal(state.senderScheduler.waiting[0].senderId, "30");

const restoredState = { senderScheduler: {
  active: { senderId: "40", turnId: "lost", record: { sender_id: 40, chat_id: -1, message_id: 6, message_ids: [6], text: "restore", attachments: [] } },
  waiting: [{ senderId: "50", record: { sender_id: 50, chat_id: -1, message_id: 7, message_ids: [7], text: "later", attachments: [] } }],
} };
const restoredCalls = [];
const restored = new SenderTurnScheduler({ state: restoredState, saveState: async () => {},
  dispatch: async (record) => { restoredCalls.push(record.sender_id); return { result: "started", turnId: "restored-turn" }; } });
await restored.restore();
assert.deepEqual(restoredCalls, [40]);
assert.equal(restoredState.senderScheduler.active.turnId, "restored-turn");
assert.equal(restoredState.senderScheduler.waiting[0].senderId, "50");

const retryState = { senderScheduler: {
  active: { senderId: "60", turnId: "done", record: { sender_id: 60, message_id: 8, text: "done" } },
  waiting: [{ senderId: "70", record: { sender_id: 70, message_id: 9, text: "must survive" }, parts: [] }],
} };
let retryAttempts = 0;
const retryScheduler = new SenderTurnScheduler({ state: retryState, saveState: async () => {},
  dispatch: async () => {
    retryAttempts += 1;
    if (retryAttempts === 1) throw new Error("temporary dispatch failure");
    return { result: "started", turnId: "retry-turn" };
  } });
await assert.rejects(retryScheduler.complete("done"), /temporary dispatch failure/);
assert.equal(retryState.senderScheduler.active, null);
assert.equal(retryState.senderScheduler.waiting[0].senderId, "70");
assert.equal(await retryScheduler.restore(), "started");
assert.equal(retryState.senderScheduler.active.senderId, "70");
assert.equal(retryState.senderScheduler.active.turnId, "retry-turn");

console.log("PASS sender scheduler isolates active steering, FIFO waiters, merging, completion, restore, and dispatch retry");

const proState = {}; const proCalls = [];
const proScheduler = new SenderTurnScheduler({state:proState,saveState:async()=>{},allowSteer:false,
  dispatch:async record=>{proCalls.push(record);return {result:'started',turnId:`p${proCalls.length}`};}});
await proScheduler.accept({sender_id:1,message_id:1,text:'first'});
assert.equal(await proScheduler.accept({sender_id:1,message_id:2,text:'next'}),'queued');
assert.equal(proCalls.length,1);
await proScheduler.complete('p1');
assert.equal(proCalls[1].text,'next');
console.log('PASS non-steering backends queue same-sender followups');
