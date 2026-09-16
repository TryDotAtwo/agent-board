import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TelegramBoardStore} from './telegram_board_store.mjs';
const {TelegramBoardInbox}=await import('./telegram_board_inbox.mjs').catch(()=>({}));
async function setup(t,{pro=false}={}) {
  assert.equal(typeof TelegramBoardInbox,'function','board inbox is missing');
  const root=await mkdtemp(path.join(os.tmpdir(),'board-inbox-test-'));
  const store=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
  let active;const calls=[];
  const client={supportsSteer:!pro,getActiveTurnId:()=>active};
  const deliver=async r=>{calls.push(r);active='running';return 'started';};
  const inbox=new TelegramBoardInbox({store,config:{id:'astra',username:'astra',chatId:-1},client,deliver});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const add=(id,sender='peer',text=`@astra message ${id}`,kind='content')=>store.append({chat_id:-1,message_id:id,sender,sender_id:8,
    sender_is_bot:true,text,attachments:[],message_thread_id:10},{kind});
  return {inbox,store,calls,add,setActive:v=>active=v};
}

test('ordinary board traffic is sampled periodically into active work, not once per message',async t=>{
 const {inbox,add,calls,setActive}=await setup(t);let now=1000;
 inbox.now=()=>now;inbox.reviewMs=300000;setActive('long-goal');
 await inbox.tick();
 for(let i=1;i<=50;i++)add(i,'peer',`ordinary discussion ${i}`);
 for(let i=0;i<5;i++)await inbox.tick();assert.equal(calls.length,0);
 now+=300000;await inbox.tick();assert.equal(calls.length,1);
 assert.match(calls[0].text,/ordinary discussion/);assert.equal(calls[0].board_delivery,true);
 for(let i=0;i<5;i++)await inbox.tick();assert.equal(calls.length,1);
 now+=300000;await inbox.tick();assert.equal(calls.length,1);
 add(51,'peer','next update');setActive(undefined);now+=300000;
 await inbox.tick();assert.equal(calls.length,1,'ordinary traffic must not start an idle agent');
 setActive('long-goal');await inbox.tick();assert.equal(calls.length,2);
});
test('new addressed content is batched into the active native turn without waiting for idle',async t=>{
  const {inbox,add,calls,setActive}=await setup(t);
  assert.equal(await inbox.tick(),'idle');
  add(1);add(2);add(3,'astra');add(4,'other','working','status');
  await inbox.tick();assert.equal(calls.length,1);
  assert.match(calls[0].text,/message 1/);assert.match(calls[0].text,/message 2/);
  assert.doesNotMatch(calls[0].text,/message 3|working/);
  add(5,'another');assert.equal(await inbox.tick(),'steered');assert.equal(calls.length,2);
  await inbox.tick();assert.equal(calls.length,2);
});
test('Pro waits until idle without advancing its cursor, then receives the pending originals',async t=>{
  const {inbox,add,calls,setActive,store}=await setup(t,{pro:true});
  setActive('existing');add(1);await inbox.tick();assert.equal(calls.length,0);
  assert.equal(store.getState('inbox:astra').cursor,0);
  setActive(undefined);await inbox.tick();assert.equal(calls.length,1);
  assert.match(calls[0].text,/message 1/);
});

test('Pro receives a collective batch from several peers instead of one turn per sender',async t=>{
  const {inbox,add,calls}=await setup(t,{pro:true});
  add(1,'alice');add(2,'bob');add(3,'charlie');
  await inbox.tick();
  assert.deepEqual(calls[0].message_ids,[1,2,3]);
});
test('an uncertain dispatch is durable and not blindly repeated',async t=>{
  const {inbox,add,store}=await setup(t);let attempts=0;
  inbox.deliver=async()=>{attempts++;throw new Error('connection lost');};add(1);
  await assert.rejects(()=>inbox.tick(),/connection lost/);
  assert.equal(await inbox.tick(),'blocked');assert.equal(attempts,1);
  assert.equal(store.getState('inbox:astra').cursor,0);
  assert.equal(store.getState('inbox:astra').pending.record.message_id,1);
});
test('initial activation does not replay old history; restart keeps the persisted unread cursor',async t=>{
  const {inbox,add,store,calls}=await setup(t);
  add(1);await inbox.tick();add(2);
  const again=new TelegramBoardInbox({store,config:{id:'astra',username:'astra',chatId:-1},
    client:{getActiveTurnId:()=>undefined},deliver:async r=>calls.push(r)});
  await again.tick();assert.equal(calls.length,2);assert.match(calls[1].text,/message 2/);
  const newcomer=new TelegramBoardInbox({store,config:{id:'new',username:'new',chatId:-1},
    client:{getActiveTurnId:()=>undefined},deliver:async()=>assert.fail('history replayed')});
  assert.equal(await newcomer.tick(),'idle');
});

test('addressed messages across topics coalesce into one notification retaining original topic metadata',async t=>{
  const {inbox,store,calls}=await setup(t);
  for(let id=1;id<=3;id++) store.append({chat_id:-1,message_id:id,sender:'peer',sender_id:8,
    text:`@astra topic message ${id}`,message_thread_id:id===2?20:10,attachments:[]});
  await inbox.tick();await inbox.tick();await inbox.tick();
  assert.deepEqual(calls.map(c=>c.message_thread_id),[10]);
  assert.deepEqual(calls.map(c=>c.message_ids),[[1,2,3]]);
  assert.match(calls[0].text,/topic=20/);
});
