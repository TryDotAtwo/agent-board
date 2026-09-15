import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';

test('native research busy before handoff defers a durable notification across restart without steering',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'board-native-busy-')),file=path.join(root,'state.json');
 const store=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
 const clients=[],sent=[];let busy=true;
 const mcp={start:async()=>{},close(){},sendMessage:async text=>sent.push(text),
  readThread:async()=>({content:[{type:'text',text:JSON.stringify({thread:{id:'research',status:{type:busy?'running':'idle'}},turns:[]})}]})};
 t.after(async()=>{for(const c of clients)c.close();store.close();await rm(root,{recursive:true,force:true});});
 async function open(){
  let state;try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={};}
  const client=new DesktopCodexClient({root:path.join(root,'native'),clientFactory:()=>mcp,pollMs:100000});clients.push(client);
  await client.startOrResumeThread('peer',{threadId:'research'});
  const board=new BoardTurnTransport({state,client,expertId:'peer',saveState:s=>atomicJson(file,s),
   prepareInput:async r=>[{type:'text',text:r.text}],onStarted:async()=>{}});
  const inbox=new TelegramBoardInbox({store,config:{id:'peer',username:'peer_bot',chatId:-1},client,
   deliver:r=>board.accept(r),reconcile:r=>board.reconcile(r)});
  return {board,client,inbox};
 }
 const record={text:'addressed question'};let r=await open();
 assert.equal(await r.board.accept(record),'waiting');assert.deepEqual(sent,[]);
 assert.equal(r.client.getActiveTurnId('peer'),undefined);r.client.close();
 r=await open();assert.equal(await r.board.restore(),'waiting');
 assert.equal(await r.board.reconcile(record),'waiting');assert.deepEqual(sent,[]);
 busy=false;assert.equal(await r.board.reconcile(record),'started');
 assert.deepEqual(sent,['addressed question']);
 assert.equal(await r.board.reconcile(record),'started');assert.deepEqual(sent,['addressed question']);
 // A separate addressed batch exercises the real inbox's waiting/recovery path.
 await r.board.complete(r.client.getActiveTurnId('peer'),async()=>{});r.client.close();
 r=await open();busy=true;
 store.append({chat_id:-1,message_id:1,sender:'other',sender_id:2,text:'@peer_bot next question',attachments:[]});
 assert.equal(await r.inbox.tick(),'waiting');assert.ok(store.getState('inbox:peer').pending);
 assert.equal(await r.inbox.tick(),'waiting');assert.equal(sent.length,1);
 busy=false;assert.equal(await r.inbox.tick(),'recovered');assert.equal(sent.length,2);
 assert.equal(store.getState('inbox:peer').pending,undefined);
});
import {atomicJson} from './atomic_json.mjs';
import {BridgeRuntime} from './bridge_runtime.mjs';
import {ProSpoolClient} from './pro_spool_client.mjs';
import {TelegramBoardStore} from './telegram_board_store.mjs';
import {TelegramBoardInbox} from './telegram_board_inbox.mjs';
import {DeliveryQueue} from './delivery_queue.mjs';
import {BoardTurnTransport} from './board_turn_transport.mjs';
import {DesktopCodexClient} from './desktop_codex_client.mjs';

async function setup(t){
 const root=await mkdtemp(path.join(tmpdir(),'board-recovery-'));
 const store=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
 const queue=new DeliveryQueue({root:path.join(root,'outbound')});
 const stateFile=path.join(root,'state.json'),clients=[];
 let current,failAck=false;
 async function runtime(){
  let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={offset:0};}
  const client=new ProSpoolClient({root:path.join(root,'pro'),pollMs:100000});clients.push(client);
  await client.startOrResumeThread('peer',{chatThreadId:'permanent-chat'});
  const bridge=new BridgeRuntime({expertId:'peer',client,state,saveState:s=>atomicJson(stateFile,s),boardEnabled:true,
   telegram:{sendText:async()=>assert.fail('unexpected progress post')},expectedChat:-1,botUsername:'peer_bot',
   outbox:{listTurnArtifacts:async()=>[]},deliveryQueue:queue,deliveryWorker:{wake(){}},setTimer:()=>1,clearTimer:()=>{},
   archiveMessage:async r=>store.append(r),downloadAttachments:async r=>r,
   readTextAttachment:item=>readFile(item.local_path,'utf8')});
  await bridge.restoreScheduler();
  const inbox=new TelegramBoardInbox({store,config:{id:'peer',username:'peer_bot',chatId:-1},client,
   deliver:async record=>{const result=await bridge.dispatchBoardRecord(record);if(failAck){failAck=false;throw new Error('ack lost');}return result;},
   reconcile:record=>bridge.reconcileBoardRecord(record)});
  current={client,bridge,inbox};return current;
 }
 const add=(id,attachments=[])=>store.append({chat_id:-1,message_id:id,sender:'another_bot',sender_id:8,
  sender_is_bot:true,text:`@peer_bot request ${id}`,attachments});
 t.after(async()=>{for(const c of clients)c.close();store.close();await rm(root,{recursive:true,force:true});});
 return {root,store,queue,runtime,add,loseAck:()=>{failAck=true;},stop:()=>current.client.close()};
}

test('board restart reattaches accepted Pro work and restores its final Telegram destination',async t=>{
 const f=await setup(t);let r=await f.runtime();f.add(1);await r.inbox.tick();
 const id=r.client.getActiveTurnId('peer');assert.ok(id);f.stop();
 r=await f.runtime();assert.equal(r.client.getActiveTurnId('peer'),id);
 assert.equal((await readdir(path.join(f.root,'pro','requests'))).length,1);
 await writeFile(path.join(f.root,'pro','results',id.slice(4)+'.json'),JSON.stringify({id:id.slice(4),threadId:'permanent-chat',status:'completed',answer:'recovered answer'}));
 await r.client.tick();await r.bridge.completions;
 const state=JSON.parse(await readFile(path.join(f.root,'state.json'),'utf8'));
 assert.equal(state.boardTransport.active,null);
 const files=await readdir(path.join(f.root,'outbound'));
 assert.equal(files.filter(x=>x.endsWith('.json')).length,1);
 const delivery=JSON.parse(await readFile(path.join(f.root,'outbound',files.find(x=>x.endsWith('.json'))),'utf8'));
 assert.equal(delivery.chatId,-1);assert.equal(delivery.replyTo,1);
});

test('lost inbox acknowledgement reconciles after restart without a duplicate request or changed attachment',async t=>{
 const f=await setup(t),attachment=path.join(f.root,'proof.txt');await writeFile(attachment,'original proof');
 let r=await f.runtime();f.add(1,[{kind:'document',file_name:'proof.txt',mime_type:'text/plain',local_path:attachment}]);f.loseAck();
 await assert.rejects(r.inbox.tick(),/ack lost/);assert.ok(f.store.getState('inbox:peer').pending);f.stop();
 await writeFile(attachment,'different later file');r=await f.runtime();
 assert.equal(await r.inbox.tick(),'recovered');assert.equal(f.store.getState('inbox:peer').pending,undefined);
 const files=await readdir(path.join(f.root,'pro','requests'));assert.equal(files.length,1);
 const request=JSON.parse(await readFile(path.join(f.root,'pro','requests',files[0]),'utf8'));
 assert.match(request.prompt,/original proof/);assert.doesNotMatch(request.prompt,/different later file/);
});

test('native restart reattaches the original input and never repeats already recorded steering',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'native-board-recovery-')),stateFile=path.join(root,'state.json');
 const sent=[],clients=[];
 const mcp={start:async()=>{},close(){},sendMessage:async text=>sent.push(text),
  readThread:async()=>({content:[{type:'text',text:JSON.stringify({thread:{id:'native-chat',status:{type:'idle'}},turns:[]})}]})};
 async function transport(){
  let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={};}
  const client=new DesktopCodexClient({root:path.join(root,'native'),clientFactory:()=>mcp,pollMs:100000});clients.push(client);
  await client.startOrResumeThread('native',{threadId:'native-chat'});
  const board=new BoardTurnTransport({state,client,expertId:'native',saveState:s=>atomicJson(stateFile,s),
   prepareInput:async record=>[{type:'text',text:record.text}],onStarted:async()=>{}});
  await board.restore();return {board,client};
 }
 t.after(async()=>{for(const client of clients)client.close();await rm(root,{recursive:true,force:true});});
 let r=await transport();const first={text:'initial batch'},second={text:'peer correction'};
 await r.board.accept(first);const id=r.client.getActiveTurnId('native');
 await r.board.accept(second);assert.deepEqual(sent,['initial batch','peer correction']);r.client.close();
 r=await transport();assert.equal(r.client.getActiveTurnId('native'),id);
 assert.equal(await r.board.reconcile(second),'steered');assert.deepEqual(sent,['initial batch','peer correction']);
});

test('intent persisted before client handoff can resume after a crash and silent completion posts nothing',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'board-intent-recovery-')),stateFile=path.join(root,'state.json'),clients=[];
 t.after(async()=>{for(const c of clients)c.close();await rm(root,{recursive:true,force:true});});
 async function transport(fail=false){
  let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={};}
  const client=new ProSpoolClient({root:path.join(root,'pro'),pollMs:100000});clients.push(client);
  await client.startOrResumeThread('peer',{chatThreadId:'permanent-chat'});
  const board=new BoardTurnTransport({state,client,expertId:'peer',prepareInput:async r=>[{type:'text',text:r.text}],
   onStarted:async()=>{},saveState:async s=>{await atomicJson(stateFile,s);if(fail){fail=false;throw new Error('process stopped before handoff');}}});
  return {board,client};
 }
 let r=await transport(true);const record={text:'batch with durable intent'};
 await assert.rejects(r.board.accept(record),/before handoff/);
 assert.equal((await readdir(path.join(root,'pro','requests'))).length,0);r.client.close();
 r=await transport();await r.board.restore();assert.equal(await r.board.reconcile(record),'started');
 const id=r.client.getActiveTurnId('peer').slice(4);assert.equal((await readdir(path.join(root,'pro','requests'))).length,1);
 let final;
 r.client.on('turnCompleted',turn=>{final=turn;});
 await writeFile(path.join(root,'pro','results',id+'.json'),JSON.stringify({id,threadId:'permanent-chat',status:'completed',silent:true}));
 await r.client.tick();assert.equal(final.finalAnswer,'');
 await r.board.complete(final.id,async()=>{});assert.equal(JSON.parse(await readFile(stateFile,'utf8')).boardTransport.active,null);
});

test('retry after origin persistence failed acknowledges the existing native turn instead of steering the original twice',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'board-origin-retry-')),sent=[];
 const mcp={start:async()=>{},close(){},sendMessage:async text=>sent.push(text),
  readThread:async()=>({content:[{type:'text',text:JSON.stringify({thread:{id:'native-chat',status:{type:'idle'}},turns:[]})}]})};
 const client=new DesktopCodexClient({root,clientFactory:()=>mcp,pollMs:100000});
 t.after(async()=>{client.close();await rm(root,{recursive:true,force:true});});
 await client.startOrResumeThread('native',{threadId:'native-chat'});
 let fail=true;const state={};
 const board=new BoardTurnTransport({state,client,expertId:'native',saveState:s=>atomicJson(path.join(root,'state.json'),s),
  prepareInput:async r=>[{type:'text',text:r.text}],onStarted:async()=>{if(fail){fail=false;throw new Error('origin not saved');}}});
 const record={text:'original input'};await assert.rejects(board.accept(record),/origin not saved/);
 assert.equal(await board.reconcile(record),'started');assert.deepEqual(sent,['original input']);
});
