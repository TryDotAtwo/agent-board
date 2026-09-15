import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const {TelegramBoardStore} = await import('./telegram_board_store.mjs').catch(()=>({}));
const message=(id,extra={})=>({chat_id:-10,message_id:id,message_thread_id:100,sender_id:7,
  sender:'alice',sender_is_bot:false,text:`message ${id}`,date:100,event_type:'message',attachments:[],...extra});
async function fixture(t) {
  assert.equal(typeof TelegramBoardStore,'function','shared durable Telegram board store is missing');
  const root=await mkdtemp(path.join(os.tmpdir(),'telegram-board-test-'));
  const store=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  return {root,store};
}
test('one message received by multiple bots yields one event; an edit yields another',async t=>{
  const {store}=await fixture(t);
  const first=store.append(message(1));
  const duplicate=store.append(message(1,{addressed:true}));
  assert.equal(first.seq,duplicate.seq);
  store.append(message(1,{text:'corrected',edit_date:110,event_type:'edited_message'}));
  assert.deepEqual(store.readUpdates({chatId:-10}).messages.map(x=>x.text),['message 1','corrected']);
  assert.equal(store.search({chatId:-10,query:'message 1'}).messages.length,0);
  assert.equal(store.search({chatId:-10,query:'corrected'}).messages.length,1);
});
test('history pages beyond 120k; topic filter and cursor do not skip unreturned messages',async t=>{
  const {store}=await fixture(t);
  for(let i=1;i<=40;i++) store.append(message(i,{text:'x'.repeat(4000),message_thread_id:i%2?100:200}));
  let cursor=0; const ids=[];
  do {
    const page=store.readUpdates({chatId:-10,after:cursor,topicId:100,limit:3,maxChars:9000});
    ids.push(...page.messages.map(m=>m.message_id)); cursor=page.nextCursor;
    if(!page.hasMore) break;
  } while(true);
  assert.deepEqual(ids,Array.from({length:20},(_,i)=>i*2+1));
  assert.equal(store.readUpdates({chatId:-99}).messages.length,0);
});
test('reply discussion is isolated, author and edits retained, statuses not work events',async t=>{
  const {store}=await fixture(t);
  store.append(message(1));
  store.append(message(2,{reply_to_message_id:1,sender:'peer',sender_is_bot:true}));
  store.append(message(3,{reply_to_message_id:2}));
  store.append(message(4,{text:'started'}),{kind:'status'});
  store.append(message(5,{message_thread_id:200}));
  assert.deepEqual(store.readDiscussion({chatId:-10,messageId:2}).messages.map(m=>m.message_id),[1,2,3]);
  assert.deepEqual(store.readUpdates({chatId:-10}).messages.map(m=>m.message_id),[1,2,3,5]);
  assert.equal(store.readDiscussion({chatId:-99,messageId:2}).messages.length,0);
});
test('restart retains cursors and idempotency; repeated completed posts never send again',async t=>{
  const {root,store}=await fixture(t);
  store.append(message(1)); store.setState('astra',{cursor:1});
  assert.equal(store.beginPost('astra','job-1',{text:'answer'}).status,'new');
  store.finishPost('astra','job-1',message(2,{sender_id:99,sender:'astra',sender_is_bot:true}));
  store.close();
  const again=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
  try {
  assert.deepEqual(again.getState('astra'),{cursor:1});
  assert.equal(again.beginPost('astra','job-1',{text:'answer'}).status,'completed');
  assert.throws(()=>again.beginPost('astra','job-1',{text:'changed'}),/idempotency/i);
  assert.equal(again.readUpdates({chatId:-10}).messages.length,2);
  } finally {again.close();}
});
test('oversized single event remains atomic and is explicitly marked over budget',async t=>{
  const {store}=await fixture(t);
  store.append(message(1,{text:'a'.repeat(15000)}));
  const page=store.readUpdates({chatId:-10,maxChars:8000});
  assert.equal(page.messages.length,1);
  assert.equal(page.messages[0].text.length,15000);
  assert.equal(page.overBudget,true);
});

test('late pre-edit delivery never replaces the current version; download failures cannot erase cached bytes',async t=>{
  const {store}=await fixture(t);
  const file={kind:'document',file_unique_id:'same',file_id:'bot-a',file_name:'proof.txt'};
  store.append(message(1,{text:'latest',edit_date:110,attachments:[{...file,local_path:'/archive/proof',sha256:'abc'}]}));
  store.append(message(1,{text:'old',date:100,attachments:[file]}));
  store.append(message(1,{text:'latest',edit_date:110,attachments:[{...file,file_id:'bot-b',error:'timeout'}]}));
  const latest=store.getMessage(-10,1);
  assert.equal(latest.text,'latest');
  assert.equal(latest.attachments[0].local_path,'/archive/proof');
  assert.equal(latest.attachments[0].error,undefined);
  assert.deepEqual(store.readUpdates({chatId:-10}).messages.map(m=>m.text),['latest']);
});
