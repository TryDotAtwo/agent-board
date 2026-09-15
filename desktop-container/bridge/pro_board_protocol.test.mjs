import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const {ProBoardProtocol}=await import('./pro_board_protocol.mjs').catch(()=>({}));

async function setup(t) {
  assert.equal(typeof ProBoardProtocol,'function','Pro board protocol is missing');
  const root=await mkdtemp(path.join(os.tmpdir(),'pro-board-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];
  const call=async args=>{calls.push(args);return {message_id:73,messages:[{text:'peer result'}]};};
  return {root,calls,call,protocol:new ProBoardProtocol({root,call})};
}
const envelope=(tool,args={})=>JSON.stringify({telegram_board:{tool,arguments:args}});
test('research tools are discoverable and uncertain browser actions are not repeated',async t=>{
 const {root}=await setup(t);let calls=0;
 const tools=[{name:'browser_call',inputSchema:{type:'object',properties:{name:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['name']}}];
 const protocol=new ProBoardProtocol({root,tools,call:async()=>{calls++;throw new Error('connection lost');}});
 assert.match(protocol.instructions(),/browser_call/);
 const request={id:'f'.repeat(64),answer:envelope('browser_call',{name:'browser_navigate',arguments:{url:'https://example.org'}})};
 const first=await protocol.handle(request);assert.match(first.prompt,/connection lost/);
 await new ProBoardProtocol({root,tools,call:async()=>{calls++;}}).handle(request);assert.equal(calls,1);
});
test('research intent is durable before the external browser action begins',async t=>{
 const {root}=await setup(t);const id='e'.repeat(64);let release;
 const tools=[{name:'browser_call',inputSchema:{type:'object',properties:{}}}];
 const protocol=new ProBoardProtocol({root,tools,call:()=>new Promise(r=>{release=r;})});
 const request={id,answer:envelope('browser_call')};const active=protocol.handle(request);
 while(!release)await new Promise(r=>setTimeout(r,5));
 assert.equal(JSON.parse(await readFile(path.join(root,'board-actions',id+'.json'),'utf8')).pending,true);
 const replay=await new ProBoardProtocol({root,tools,call:()=>assert.fail('must not repeat')}).handle(request);
 assert.match(replay.prompt,/uncertain/);release({ok:true});await active;
});
test('board reads become private continuations and explicit done stays silent',async t=>{
  const {protocol,calls}=await setup(t);
  const read=await protocol.handle({id:'a'.repeat(64),answer:envelope('read_updates',{limit:5})});
  assert.match(read.prompt,/peer result/);
  assert.equal(calls[0].tool,'read_updates');
  assert.deepEqual(await protocol.handle({id:'b'.repeat(64),answer:envelope('done')}),{silent:true});
  assert.equal(await protocol.handle({id:'c'.repeat(64),answer:'ordinary answer'}),null);
});
test('a chosen reply publishes once across restart and gets a durable action result',async t=>{
  const {root,protocol,calls,call}=await setup(t);
  const request={id:'d'.repeat(64),answer:envelope('post_message',{text:'result',reply_to:42})};
  const first=await protocol.handle(request);
  const restarted=new ProBoardProtocol({root,call});
  assert.deepEqual(await restarted.handle(request),first);
  assert.equal(calls.length,1);
  assert.equal(calls[0].arguments.reply_to,42);
  assert.equal(calls[0].arguments.idempotency_key,'pro-'+'d'.repeat(64));
});
test('unknown, malformed, oversized or cross-chat commands never execute or leak as replies',async t=>{
  const {protocol,calls}=await setup(t);
  for (const answer of [envelope('exec',{command:'dir'}),envelope('post_message',{text:'oops',chat_id:1}),
    '{"telegram_board":',envelope('read_updates',{limit:100000}),envelope('done',{text:'oops'})]) {
    const result=await protocol.handle({id:String(calls.length).padStart(64,'a'),answer});
    assert.match(result.prompt,/error/i);
  }
  assert.equal(calls.length,0);
});
