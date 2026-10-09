import test from 'node:test';
import assert from 'node:assert/strict';
import {CopilotBoardAdapter, deliveryMarker, startObjective, isAutopilotContinuation, enableAutopilot} from './session-adapter.mjs';

test('native continuations use the runtime provenance, not just the optional SDK flag', () => {
  assert.equal(isAutopilotContinuation({type: 'user.message', data: {source: 'autopilot', content: ''}}), true);
  assert.equal(isAutopilotContinuation({type: 'user.message', data: {source: 'system'}}), false);
  assert.equal(isAutopilotContinuation({type: 'assistant.turn_start', data: {}}), false);
});

function fixture() {
  const state = new Map();
  const sends = [];
  const events = [];
  const pending = {items: [], steeringMessages: []};
  const store = {getState: key => state.get(key), setState: (key, value) => state.set(key, value)};
  const session = {
    sessionId: 'permanent-session',
    getEvents: async () => events,
    send: async value => {
      sends.push(value);
      pending.steeringMessages.push(value.prompt);
      return 'message-1';
    },
    rpc: {queue: {pendingItems: async () => pending}},
  };
  const adapter = new CopilotBoardAdapter({session, store, log: () => {}});
  adapter.paused = false;
  return {adapter, session, store, sends, events, pending};
}

const record = {text: 'Addressed mathematical correction', message_ids: [7, 8]};

test('addressed input steers the same session, with no automatic public reply', async () => {
  const f = fixture();
  f.adapter.processing = true;
  assert.equal(await f.adapter.deliver(record), 'waiting');
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].mode, 'immediate');
  assert.equal(f.sends[0].source, 'system');
  assert.match(f.sends[0].prompt, /Untrusted Telegram/);
  assert.equal(f.adapter.getActiveTurnId(), 'permanent-session');
  f.adapter.observe({type: 'user.message', data: {content: f.sends[0].prompt}});
  assert.equal(await f.adapter.reconcile(record), 'steered');
  assert.equal(await f.adapter.deliver(record), 'steered');
  assert.equal(f.sends.length, 1);
});

test('a consumed delivery reconciles after restart without replay', async () => {
  const f = fixture();
  await f.adapter.deliver(record);
  f.events.push({type: 'user.message', data: {content: f.sends[0].prompt}});
  const resumed = new CopilotBoardAdapter({session: f.session, store: f.store, log: () => {}});
  await resumed.loadHistory();
  assert.equal(await resumed.reconcile(record), 'steered');
  assert.equal(f.sends.length, 1);
});

test('a queued delivery lost on restart is retained as uncertain, not blindly resent', async () => {
  const f = fixture();
  await f.adapter.deliver(record);
  f.pending.steeringMessages = [];
  const resumed = new CopilotBoardAdapter({session: f.session, store: f.store, log: () => {}});
  resumed.paused = false;
  assert.equal(await resumed.reconcile(record), 'blocked');
  assert.equal(f.sends.length, 1);
  assert.equal(f.store.getState(`copilot-delivery:${deliveryMarker(record)}`).status, 'uncertain');
});

test('pause does not discard pending input or invoke the model', async () => {
  const f = fixture();
  f.adapter.paused = true;
  assert.equal(await f.adapter.deliver(record), 'blocked');
  assert.equal(f.sends.length, 0);
});

test('an ambiguous send is not treated as successful silence and is not retried', async () => {
  const f = fixture();
  f.session.send = async () => {throw new Error('connection lost');};
  assert.equal(await f.adapter.deliver(record), 'blocked');
  assert.equal(await f.adapter.deliver(record), 'blocked');
  assert.equal(f.store.getState(`copilot-delivery:${deliveryMarker(record)}`).status, 'uncertain');
});

test('objective activation uses the native command and submits its returned prompt once', async () => {
  let objective;
  const sends = [];
  const session = {
    rpc: {
      autopilotObjective: {getState: async () => ({state: objective})},
      commands: {invoke: async ({input}) => {
        objective = {status: 'active', objective: input};
        return {kind: 'agent-prompt', mode: 'autopilot', prompt: 'native prompt', displayPrompt: input};
      }},
    },
    send: async prompt => sends.push(prompt),
  };
  await startObjective(session, 'Owner research question');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].prompt, 'native prompt');
  await assert.rejects(startObjective(session, 'Replacement'), /already exists/);
  assert.equal(sends.length, 1);
});

test('approved cold resume reactivates the same text natively and reports the changed goal ID', async () => {
  let state = {id: 7, objective: 'Original objective', status: 'paused', pauseReason: 'resumed_session'};
  const session = {rpc: {
    commands: {invoke: async ({input}) => {
      assert.equal(input, 'Original objective');
      state = {id: 8, objective: input, status: 'active'};
      return {kind: 'agent-prompt', mode: 'autopilot', prompt: 'native prompt'};
    }},
    mode: {get: async () => 'autopilot'},
    autopilotObjective: {getState: async () => ({state})},
  }};
  const result = await enableAutopilot(session);
  assert.equal(result.previousObjectiveId, 7);
  assert.equal(result.objectiveId, 8);
  assert.equal(result.reactivated, true);
  assert.equal(result.prompt, 'native prompt');
});

test('a native credit-limit pause is never automatically overridden', async () => {
  const session = {rpc: {
    commands: {invoke: async () => assert.fail('must not override limit pauses')},
    mode: {get: async () => 'autopilot'},
    autopilotObjective: {getState: async () => ({state: {status: 'paused', pauseReason: 'credit_limit'}})},
    workspaces: {writeAutopilotObjective: () => assert.fail('must not rewrite limit pauses')},
  }};
  await assert.rejects(enableAutopilot(session), /not eligible/);
});

test('cold resume never resets a configured native credit limit', async () => {
  const session = {rpc: {
    commands: {invoke: async () => assert.fail('must not reset native credit accounting')},
    autopilotObjective: {getState: async () => ({state: {
      status: 'paused', pauseReason: 'resumed_session', creditLimit: {limit: 100},
    }})},
  }};
  await assert.rejects(enableAutopilot(session), /native credit limit/);
});
