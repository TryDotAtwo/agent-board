import test from 'node:test';import assert from 'node:assert/strict';
test('bootstrap passes separate gateway and tool socket bindings to the supervisor',async()=>{
 const {bootstrapContext}=await import('./desktop_bootstrap.mjs');
 const gateways=[{id:'bob',threadId:'bob-chat',root:'/data/pro-gateway/bob'},{id:'carol',threadId:'carol-chat',root:'/data/pro-gateway/carol'}];
 const result=bootstrapContext({hook_event_name:'SessionStart',session_id:'executor'},
  {CODEX_APP_TOOLS_PIPE_PATH:'/tmp/real-pipe'},{astraThreadId:'executor',gateways,boardSockets:['/data/telegram-board/tools-alice.sock']});
 assert.deepEqual(JSON.parse(result.BOARD_PRO_GATEWAYS),gateways);
 assert.deepEqual(JSON.parse(result.BOARD_TOOL_SOCKETS),['/data/telegram-board/tools-alice.sock']);
});
test('bootstrap accepts only the configured real SessionStart context',async()=>{
 const {bootstrapContext}=await import('./desktop_bootstrap.mjs').catch(()=>({}));
 assert.equal(typeof bootstrapContext,'function');
 const config={astraThreadId:'a',proThreadId:'p'};
 assert.equal(bootstrapContext({hook_event_name:'SessionStart',session_id:'other'},{CODEX_APP_TOOLS_PIPE_PATH:'/tmp/socket'},config),null);
 assert.throws(()=>bootstrapContext({hook_event_name:'SessionStart',session_id:'a'},{},config),/Desktop/);
 const env=bootstrapContext({hook_event_name:'SessionStart',session_id:'a'},{CODEX_APP_TOOLS_PIPE_PATH:'/tmp/socket'},config);
 assert.equal(env.CODEX_THREAD_ID,'a');assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH,'/tmp/socket');
 assert.equal(bootstrapContext({hook_event_name:'Stop',session_id:'a'},env,config),null);
});
