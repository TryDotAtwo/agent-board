import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProSpoolClient } from './pro_spool_client.mjs';
import { BridgeRuntime } from './bridge_runtime.mjs';
import { ProBoardProtocol } from './pro_board_protocol.mjs';

test('agent-selected wake waits without sends, survives restart and continues the same chat once',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pro-wake-'));let now=100000;const clients=[];
 const create=()=>{const c=new ProSpoolClient({root,pollMs:60000,now:()=>now,
  boardProtocol:new ProBoardProtocol({root,now:()=>now,call:()=>assert.fail('wake must not post or call external tools')})});clients.push(c);return c;};
 t.after(async()=>{for(const c of clients)c.close();await rm(root,{recursive:true,force:true});});
 let c=create();await c.startOrResumeThread('pro',{chatThreadId:'same-chat'});
 const input=[{type:'text',text:'research'}],turn=await c.startTurn('pro',input),id=turn.id.slice(4);
 await writeFile(path.join(root,'results',id+'.json'),JSON.stringify({id,threadId:'same-chat',status:'completed',
  answer:JSON.stringify({telegram_board:{tool:'wake_after',arguments:{seconds:60,reason:'Continue checking the lemma'}}})}));
 await c.tick();assert.equal((await readdir(path.join(root,'requests'))).length,1);
 now+=30000;c.close();c=create();await c.startOrResumeThread('pro',{chatThreadId:'same-chat'});
 assert.equal((await c.startTurn('pro',input)).id,turn.id);await c.tick();
 assert.equal((await readdir(path.join(root,'requests'))).length,1);
 now+=30000;await c.tick();await c.tick();
 const files=await readdir(path.join(root,'requests'));assert.equal(files.length,2);
 const next=JSON.parse(await readFile(path.join(root,'requests',files.find(f=>f!==id+'.json')),'utf8'));
 assert.equal(next.threadId,'same-chat');assert.match(next.prompt,/Continue checking the lemma/);
 assert.equal(c.getActiveTurnId('pro'),turn.id);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pro-client-'));
  const client = new ProSpoolClient({ root, pollMs: 60000 });
  t.after(async () => { client.close(); await rm(root, { recursive: true, force: true }); });
  await client.startOrResumeThread('pro', { chatThreadId: 'chat-pro' });
  return { root, client };
}
test('a tool catalog upgrade preserves the exact existing queued prompt rather than resending',async t=>{
 const {root,client}=await fixture(t);client.boardProtocol={instructions:()=> 'Old tool catalog'};
 const input=[{type:'text',text:'existing question'}];const turn=await client.startTurn('pro',input);client.close();
 const resumed=new ProSpoolClient({root,pollMs:60000,boardProtocol:{instructions:()=> 'New tool catalog'}});t.after(()=>resumed.close());
 await resumed.startOrResumeThread('pro',{chatThreadId:'chat-pro'});
 assert.equal((await resumed.startTurn('pro',input)).id,turn.id);
 const files=await readdir(path.join(root,'requests'));assert.equal(files.length,1);
 assert.equal(JSON.parse(await readFile(path.join(root,'requests',files[0]),'utf8')).prompt,'Old tool catalog\n\nexisting question');
});

test('board command continuations preserve one root turn and replay without duplicate publication',async t=>{
  const {root,client}=await fixture(t);
  const posts=[];
  const protocol=new ProBoardProtocol({root,call:async op=>{posts.push(op);return {message_id:88};}});
  client.boardProtocol=protocol;
  const input=[{type:'text',text:'collective discussion'}];
  const turn=await client.startTurn('pro',input);
  const [first]=await readdir(path.join(root,'requests'));
  const req=JSON.parse(await readFile(path.join(root,'requests',first),'utf8'));
  assert.match(req.prompt,/telegram_board/);
  await writeFile(path.join(root,'results',first),JSON.stringify({id:req.id,threadId:req.threadId,status:'completed',
    answer:JSON.stringify({telegram_board:{tool:'post_message',arguments:{text:'finding',reply_to:2}}})}));
  const done=[];client.on('turnCompleted',v=>done.push(v));
  await client.tick();
  assert.equal(done.length,0);assert.equal(posts.length,1);
  assert.equal(client.getActiveTurnId('pro'),turn.id);
  const files=await readdir(path.join(root,'requests'));
  assert.equal(files.length,2);
  client.close();
  const resumed=new ProSpoolClient({root,pollMs:60000,boardProtocol:protocol});t.after(()=>resumed.close());
  resumed.on('turnCompleted',v=>done.push(v));
  await resumed.startOrResumeThread('pro',{chatThreadId:'chat-pro'});
  assert.equal((await resumed.startTurn('pro',input)).id,turn.id);
  await resumed.tick();assert.equal(posts.length,1);
  const second=files.find(f=>f!==first);
  const next=JSON.parse(await readFile(path.join(root,'requests',second),'utf8'));
  await writeFile(path.join(root,'results',second),JSON.stringify({id:next.id,threadId:next.threadId,status:'completed',
    answer:'{"telegram_board":{"tool":"done","arguments":{}}}'}));
  await resumed.tick();
  assert.equal(done.length,1);assert.equal(done[0].id,turn.id);assert.equal(done[0].finalAnswer,'');
});
test('spool submits exact text, persists stable identity and delivers full response once', async t => {
  const { root, client } = await fixture(t);
  assert.equal(client.supportsSteer, false);
  const completions = []; client.on('turnCompleted', x => completions.push(x));
  const turn = await client.startTurn('pro', [{ type: 'text', text: 'Ask\nTelegram message_id=91' }]);
  assert.equal(completions.length, 0);
  const [name] = await readdir(path.join(root, 'requests'));
  const req = JSON.parse(await readFile(path.join(root, 'requests', name), 'utf8'));
  assert.match(req.id, /^[a-f0-9]{64}$/);
  assert.equal(req.prompt, 'Ask\nTelegram message_id=91');
  const answer = 'Long answer\n'.repeat(1000);
  await mkdir(path.join(root, 'results'), { recursive: true });
  await writeFile(path.join(root, 'results', name), JSON.stringify({ id: req.id, threadId: req.threadId, status: 'completed', answer }));
  await client.tick(); await client.tick();
  assert.equal(completions.length, 1);
  assert.equal(completions[0].finalAnswer, answer);
  assert.equal(completions[0].id, turn.id);
  assert.equal(client.getActiveTurnId('pro'), undefined);
  client.close();
  const restarted = new ProSpoolClient({ root, pollMs: 60000 });
  t.after(() => restarted.close());
  await restarted.startOrResumeThread('pro', { chatThreadId: 'chat-pro', threadId: 'chat-pro' });
  assert.equal((await restarted.startTurn('pro', [{ type: 'text', text: req.prompt }])).id, turn.id);
  assert.equal((await readdir(path.join(root, 'requests'))).length, 1);
});
test('a completed silent result releases the Pro turn without a Telegram answer', async t => {
  const {root,client}=await fixture(t);
  const done=[];client.on('turnCompleted',x=>done.push(x));
  await client.startTurn('pro',[{type:'text',text:'No reply needed'}]);
  const [name]=await readdir(path.join(root,'requests'));
  const req=JSON.parse(await readFile(path.join(root,'requests',name),'utf8'));
  await mkdir(path.join(root,'results'),{recursive:true});
  await writeFile(path.join(root,'results',name),JSON.stringify({id:req.id,threadId:req.threadId,status:'completed',silent:true}));
  await client.tick();
  assert.equal(done.length,1);
  assert.equal(done[0].finalAnswer,'');
  assert.equal(client.getActiveTurnId('pro'),undefined);
});
test('wrong target and malformed result never complete active turn', async t => {
  const { root, client } = await fixture(t);
  await assert.rejects(client.startOrResumeThread('other', { chatThreadId:'chat-pro',threadId:'changed' }), /match/);
  let completed = false; client.on('turnCompleted', () => { completed = true; });
  await client.startTurn('pro', [{ type:'text',text:'question' }]);
  const [name] = await readdir(path.join(root,'requests'));
  await mkdir(path.join(root,'results'), {recursive:true});
  await writeFile(path.join(root,'results',name), JSON.stringify({id:name.slice(0,-5),threadId:'wrong',status:'completed',answer:'leak'}));
  await client.tick(); assert.equal(completed,false); assert(client.getActiveTurnId('pro'));
  await assert.rejects(client.steerTurn('pro', []), /not support/);
});
test('unsupported images and local-file references produce explicit reply without Chat send', async t => {
  const { root, client } = await fixture(t);
  const done=[]; client.on('turnCompleted',x=>done.push(x));
  await client.startTurn('pro',[{type:'text',text:'look'},{type:'localImage',path:'/data/file.png'}]);
  await client.tick();
  assert.match(done[0].finalAnswer,/вложен/i);
  assert.equal((await readdir(path.join(root,'requests'))).length,0);
  await client.startTurn('pro',[{type:'text',text:'x\n\nВложения доступны только на чтение:\n- /data/a.pdf'}]);
  await client.tick(); assert.equal(done.length,2);
  await client.startTurn('pro',[{type:'text',text:'x'.repeat(19001)}]);
  await client.tick();assert.equal(done.length,3);assert.match(done[2].finalAnswer,/19 000/);
});

test('crash after spool publication restores Telegram origin from durable dispatch intent', async t => {
  const {root,client}=await fixture(t);
  let persisted={}; const state={};
  const callbacks={expertId:'pro',expectedChat:-100,botUsername:'pro_bot',state,
    saveState:async x=>{persisted=structuredClone(x);},archiveMessage:async()=>{},downloadAttachments:async x=>x,
    outbox:{listTurnArtifacts:async()=>[]},deliveryQueue:{enqueue:async()=>{}},deliveryWorker:{wake:()=>{}},
    setTimer:()=>0,clearTimer:()=>{},telegram:{sendText:async()=>{}}};
  const original=client.startTurn.bind(client);
  client.startTurn=async(...args)=>{await original(...args);throw new Error('simulated crash after publish');};
  const runtime=new BridgeRuntime({...callbacks,client});
  await runtime.processUpdate({update_id:17,message:{message_id:16,chat:{id:-100},from:{id:7,username:'alice'},text:'@pro_bot question'}});
  await assert.rejects(runtime.flushInputs(),/simulated crash/);
  assert.equal(persisted.senderScheduler.active.record.message_id,16);
  client.close();
  const restoredClient=new ProSpoolClient({root,pollMs:60000});t.after(()=>restoredClient.close());
  await restoredClient.startOrResumeThread('pro',{chatThreadId:'chat-pro'});
  const restoredState=structuredClone(persisted);
  const restoredRuntime=new BridgeRuntime({...callbacks,state:restoredState,client:restoredClient});
  await restoredRuntime.restoreScheduler();
  assert.deepEqual(restoredState.origins[restoredClient.getActiveTurnId('pro')],{chatId:-100,replyTo:16});
  assert.equal((await readdir(path.join(root,'requests'))).length,1);
});

test('failed and oversized attachments are explicitly rejected before a Chat send',async t=>{
  const {root,client}=await fixture(t);
  const {TelegramDispatcher}=await import('./telegram_dispatcher.mjs');
  const dispatcher=new TelegramDispatcher({client,expertId:'pro'});const done=[];
  client.on('turnCompleted',x=>done.push(x));
  for(const [message_id,kind] of [[23,'document'],[24,'photo']]) {
    await dispatcher.dispatch({addressed:true,sender:'alice',text:'check',message_id,attachments:[{kind,error:'download failed'}]});
    await client.tick();
  }
  assert.equal(done.length,2);assert(done.every(x=>/Вложения не отправлены/.test(x.finalAnswer)));
  assert.equal((await readdir(path.join(root,'requests'))).length,0);
});

test('a long-running Pro turn stays silent until its real answer arrives', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pro-progress-'));
  let now = 1_000;
  const client = new ProSpoolClient({ root, pollMs: 60_000, now: () => now, progressIntervalMs: 120_000 });
  t.after(async () => { client.close(); await rm(root, { recursive: true, force: true }); });
  await client.startOrResumeThread('pro', { chatThreadId: 'chat-pro' });
  const commentary = [];
  client.on('commentary', event => commentary.push(event));

  await client.startTurn('pro', [{ type: 'text', text: 'A question requiring a long answer' }]);
  assert.deepEqual(commentary, []);

  now += 119_999;
  await client.tick();
  assert.equal(commentary.length, 0);
  now += 1;
  await client.tick();
  assert.deepEqual(commentary, []);

  now += 120_000;
  await client.tick();
  assert.deepEqual(commentary, []);
  const [file] = await readdir(path.join(root, 'requests'));
  const request = JSON.parse(await readFile(path.join(root, 'requests', file), 'utf8'));
  const completed = [];
  client.on('turnCompleted', event => completed.push(event));
  await writeFile(path.join(root, 'results', file), JSON.stringify({id:request.id,threadId:request.threadId,status:'completed',answer:'Real answer'}));
  await client.tick();
  assert.equal(completed[0].finalAnswer, 'Real answer');
  assert.deepEqual(commentary, []);
});
