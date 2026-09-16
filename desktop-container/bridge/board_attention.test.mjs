import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {TelegramBoardStore} from './telegram_board_store.mjs';
import {TelegramBoardInbox} from './telegram_board_inbox.mjs';
import {telegramRecord} from './bridge_core.mjs';
import {TelegramBoardService} from './telegram_board_service.mjs';

async function setup(t){
 const root=await mkdtemp(path.join(tmpdir(),'board-attention-'));
 const store=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 let active;const delivered=[];
 const inbox=new TelegramBoardInbox({store,config:{id:'participant',username:'participant_bot',chatId:-1},
  client:{supportsSteer:true,getActiveTurnId:()=>active},deliver:async record=>{delivered.push(record);active='running';return 'started';}});
 const add=(id,text,extra={})=>store.append({chat_id:-1,message_id:id,sender:'peer_bot',sender_id:2,text,attachments:[],...extra});
 return {store,inbox,delivered,add,setActive:value=>active=value};
}

test('ordinary board traffic never invokes an agent and remains available for voluntary reading',async t=>{
 const f=await setup(t);for(let id=1;id<=1000;id++)f.add(id,`peer finding ${id}`);
 assert.equal(await f.inbox.tick(),'idle');assert.equal(f.delivered.length,0);
 assert.equal(f.store.getMessage(-1,999).text,'peer finding 999');
 assert.equal(f.store.getState('inbox:participant').cursor,f.store.lastSeq());
});

test('addressed flood during steerable active work becomes one bounded correction, not one turn per message',async t=>{
 const f=await setup(t);f.setActive('own research');
 for(let id=1;id<=500;id++)f.add(id,`@participant_bot question ${id}`);
 assert.equal(await f.inbox.tick(),'steered');assert.equal(f.delivered.length,1);
 assert.ok(f.delivered[0].text.length<19000);assert.ok(f.delivered[0].message_ids.length<=8);
 assert.match(f.delivered[0].text,/500/);assert.match(f.delivered[0].text,/read_mentions/);
 f.setActive(undefined);assert.equal(await f.inbox.tick(),'idle');assert.equal(f.delivered.length,1);
 assert.equal(f.store.getMessage(-1,1).text,'@participant_bot question 1');
});

test('only exact mention or reply to this bot gets attention; removed mentions and self posts do not',async t=>{
 const f=await setup(t);
 f.add(1,'@participant_bot_extra unrelated');f.add(2,'@other_bot unrelated');
 f.add(3,'@participant_bot obsolete',{date:1});f.add(3,'mention removed',{date:1,edit_date:2,event_type:'edited_message'});
 f.add(4,'@participant_bot self',{sender:'participant_bot'});
 f.add(5,'direct question',{reply_to_sender:'participant_bot',reply_to_message_id:400});
 await f.inbox.tick();assert.deepEqual(f.delivered[0].message_ids,[5]);
});

test('non-steerable adapters retain the addressed batch while active',async t=>{
 const f=await setup(t);f.inbox.client.supportsSteer=false;f.setActive('running');
 f.add(1,'@participant_bot direct question');
 assert.equal(await f.inbox.tick(),'waiting');assert.equal(f.delivered.length,0);
 f.setActive(undefined);assert.equal(await f.inbox.tick(),'started');
 assert.equal(f.delivered.length,1);
});

test('reply attribution survives journal ingestion even when the parent predates installation',()=>{
 const record=telegramRecord({chat:{id:-1},message_id:8,from:{id:2,username:'peer_bot'},text:'question',
  reply_to_message:{message_id:1,from:{id:3,username:'participant_bot',is_bot:true}}});
 assert.equal(record.reply_to_sender,'participant_bot');
});

test('all coalesced questions remain pageable through the bound tool without changing voluntary reading position',async t=>{
 const f=await setup(t);for(let id=1;id<=21;id++)f.add(id,`@participant_bot question ${id}`);
 const service=new TelegramBoardService({store:f.store,configs:[{id:'participant',board:true,chatId:-1,username:'participant_bot'}],
  send:async()=>assert.fail('reading must not post')});
 const read=arguments_=>service.call({expertId:'participant',tool:'read_mentions',arguments:arguments_});
 const first=await read({limit:8});assert.deepEqual(first.messages.map(m=>m.message_id),[14,15,16,17,18,19,20,21]);
 const second=await read({through_cursor:first.nextBeforeCursor,limit:8});assert.deepEqual(second.messages.map(m=>m.message_id),[6,7,8,9,10,11,12,13]);
 const last=await read({through_cursor:second.nextBeforeCursor,limit:8});assert.deepEqual(last.messages.map(m=>m.message_id),[1,2,3,4,5]);
 assert.equal(last.hasMore,false);assert.equal(f.store.getState('read:participant'),undefined);
 await assert.rejects(service.call({expertId:'other',tool:'read_mentions'}),/not authorized/);
});
