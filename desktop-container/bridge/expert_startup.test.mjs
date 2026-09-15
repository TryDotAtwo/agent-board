import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeExpertThread} from './expert_startup.mjs';
test('fresh portable participant attaches to its configured chat, not a new conversation',async()=>{
 const calls=[];
 const result=await initializeExpertThread({config:{id:'alice',board:true,initialThreadId:'configured'},state:{},
  client:{startOrResumeThread:async(id,options)=>calls.push(options)},options:threadId=>({threadId}),log:async()=>{}});
 assert.equal(result,true);assert.deepEqual(calls,[{threadId:'configured'}]);
});
test('changed configuration cannot silently replace an existing board conversation',async()=>{
 let calls=0;const state={threadId:'stored'};
 const result=await initializeExpertThread({config:{id:'alice',board:true,initialThreadId:'other'},state,
  client:{startOrResumeThread:async()=>{calls++;}},options:threadId=>({threadId}),log:async()=>{}});
 assert.equal(result,false);assert.equal(calls,0);assert.equal(state.threadId,'stored');
});
test('failed first board attachment does not retry by creating a new task',async()=>{
 let calls=0;
 const result=await initializeExpertThread({config:{id:'alice',board:true,initialThreadId:'configured'},state:{},
  client:{startOrResumeThread:async()=>{calls++;throw new Error('unavailable');}},options:threadId=>({threadId}),log:async()=>{}});
 assert.equal(result,false);assert.equal(calls,1);
});
test('failed Pro startup stays unavailable without replacing Chat or rejecting native startup loop',async()=>{
  let calls=0;const log=[];
  const result=await initializeExpertThread({config:{id:'pro',backend:'desktop-chat'},client:{startOrResumeThread:async()=>{calls++;throw new Error('spool denied');}},state:{threadId:'old'},options:()=>({}),log:async x=>log.push(x)});
  assert.equal(result,false);assert.equal(calls,1);assert.match(log[0],/unavailable/);
});
test('native startup still falls back to new native thread after resume failure',async()=>{
  const calls=[];const state={threadId:'old'};
  const result=await initializeExpertThread({config:{id:'a',backend:'codex'},client:{startOrResumeThread:async(id,options)=>{calls.push(options);if(options.threadId)throw new Error('old missing');}},state,options:threadId=>({threadId}),log:async()=>{}});
  assert.equal(result,true);assert.equal(calls.length,2);assert.equal(state.legacyThreadId,'old');
});
