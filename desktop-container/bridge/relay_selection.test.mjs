import test from 'node:test';
import assert from 'node:assert/strict';
test('gateway commands isolate each configured Pro chat and spool',async()=>{
 const {relayCommands}=await import('./relay_supervisor.mjs');
 const commands=relayCommands({BOARD_PRO_GATEWAYS:JSON.stringify([
  {id:'bob',threadId:'22222222-2222-4222-8222-222222222222',root:'/data/pro-gateway/bob'},
  {id:'carol',threadId:'33333333-3333-4333-8333-333333333333',root:'/data/pro-gateway/carol'}
 ]),BOARD_TOOL_SOCKETS:'[]'});
 assert.deepEqual(commands.map(c=>c.name),['pro-bob','pro-carol','board']);
 assert.equal(commands[0].env.PRO_GATEWAY_ROOT,'/data/pro-gateway/bob');
 assert.equal(commands[1].env.PRO_CHAT_THREAD_ID,'33333333-3333-4333-8333-333333333333');
});
test('unsafe cleanup paths are rejected before a relay can start',async()=>{
 const {relayCommands}=await import('./relay_supervisor.mjs');
 assert.throws(()=>relayCommands({BOARD_TOOL_SOCKETS:'["/tmp/unrelated.sock"]'}),/socket/i);
 assert.throws(()=>relayCommands({BOARD_PRO_GATEWAYS:JSON.stringify([{id:'bob',threadId:'22222222-2222-4222-8222-222222222222',root:'/data/other'}])}),/gateway/i);
});
test('an unconfigured Pro backend does not become a permanently crashing child',async()=>{
 const mod=await import('./relay_supervisor.mjs');
 assert.equal(typeof mod.relayCommands,'function','relay command selection is required');
 assert.deepEqual(mod.relayCommands({}).map(c=>c.name),['board']);
 assert.deepEqual(mod.relayCommands({PRO_CHAT_THREAD_ID:'configured-chat'}).map(c=>c.name),['pro','board']);
});
