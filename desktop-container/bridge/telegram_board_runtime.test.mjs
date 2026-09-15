import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {BridgeRuntime} from './bridge_runtime.mjs';
import {TelegramBoardStore} from './telegram_board_store.mjs';
import {TelegramBoardInbox} from './telegram_board_inbox.mjs';
import {TelegramBotClient} from './telegram_output.mjs';
import {DeliveryQueue} from './delivery_queue.mjs';
import {DeliveryWorker} from './delivery_worker.mjs';
import {dynamicToolSpecs} from './dynamic_tool_specs.mjs';
import {TurnBoundToolDispatcher} from './turn_bound_tools.mjs';
import {TelegramDispatcher} from './telegram_dispatcher.mjs';

test('Pro board exposes unsupported attachment metadata without claiming to read it or blocking the board',async()=>{
  let sent;
  const client={supportsAttachments:false,getActiveTurnId:()=>null,startTurn:async(_id,input)=>{sent=input;}};
  const dispatcher=new TelegramDispatcher({client,expertId:'pro'});
  await dispatcher.dispatch({addressed:true,board_delivery:true,sender:'peer',message_id:2,text:'Look at this',
    attachments:[{kind:'photo',file_name:'figure.png',mime_type:'image/png',local_path:'/tmp/photo',sha256:'abc'}]});
  assert.equal(sent.length,1);
  assert.equal(sent[0].type,'text');
  assert.match(sent[0].text,/figure.png/);
  assert.match(sent[0].text,/не передано/);
});

test('ordinary context stays in the journal; an addressed question can produce a reply in its Telegram topic',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'board-runtime-test-'));
  const store=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const client=new EventEmitter();let active;const inputs=[];
  client.getActiveTurnId=()=>active;
  client.startTurn=async(id,input)=>{active='turn1';inputs.push(input);client.emit('turnStarted',{id:active,expertId:id});return {id:active};};
  client.steerTurn=async(_id,input)=>inputs.push(input);
  const sent=[];const telegram={sendText:async body=>sent.push(body)};
  const queue=new DeliveryQueue({root:path.join(root,'queue')});
  const worker=new DeliveryWorker({queue,client:telegram,setTimer:()=>1,clearTimer:()=>{}});
  const runtime=new BridgeRuntime({expertId:'astra',client,telegram,state:{offset:0},saveState:async()=>{},
    archiveMessage:async r=>store.append(r),downloadAttachments:async r=>r,expectedChat:-1,botUsername:'astra',boardEnabled:true,
    outbox:{listTurnArtifacts:async()=>[]},deliveryQueue:queue,deliveryWorker:worker,setTimer:()=>1,clearTimer:()=>{}});
  const inbox=new TelegramBoardInbox({store,config:{id:'astra',username:'astra',chatId:-1},client,
    deliver:r=>runtime.dispatchBoardRecord(r)});
  await runtime.processUpdate({update_id:1,message:{message_id:1,message_thread_id:88,chat:{id:-1},from:{id:8,username:'peer',is_bot:true},text:'new result'}});
  await runtime.flushInputs();assert.equal(inputs.length,0);
  await inbox.tick();assert.equal(inputs.length,0);assert.equal(store.getMessage(-1,1).text,'new result');
  await runtime.processUpdate({update_id:2,message:{message_id:2,message_thread_id:88,chat:{id:-1},from:{id:8,username:'peer',is_bot:true},text:'@astra check this result'}});
  await inbox.tick();assert.equal(inputs.length,1);assert.match(inputs[0][0].text,/check this result/);
  active=undefined;client.emit('turnCompleted',{id:'turn1',expertId:'astra',finalAnswer:'counterexample'});
  await runtime.completions;await worker.drainDue();
  assert.equal(sent[0].topicId,88);assert.equal(sent[0].replyTo,2);
});

test('Telegram send preserves topic and reports status metadata only to the observer',async()=>{
  const bodies=[],observed=[];
  const telegram=new TelegramBotClient({token:'test',onMessage:async(m,meta)=>observed.push({m,meta}),
    fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return {ok:true,status:200,
      json:async()=>({ok:true,result:{message_id:20,chat:{id:-1},from:{id:9,is_bot:true},text:'working'}})};}});
  await telegram.sendText({chatId:-1,text:'working',topicId:88,deliveryKind:'status'});
  assert.equal(bodies[0].message_thread_id,88);
  assert.equal(bodies[0].deliveryKind,undefined);
  assert.equal(observed[0].meta.kind,'status');
});

test('only board experts discover board tools and their calls retain bound identity',async()=>{
  const names=dynamicToolSpecs({board:true,includeHistory:false}).map(s=>s.name);
  assert.ok(names.includes('telegram_board'));assert.ok(!names.includes('windows_codex_history'));
  assert.ok(!dynamicToolSpecs().some(s=>s.name==='telegram_board'));
  const dispatcher=new TurnBoundToolDispatcher({board:{call:async request=>request}});
  const result=await dispatcher.call({expertId:'astra',turnId:'t1',namespace:'telegram_board',tool:'read_updates',arguments:{after_cursor:2}});
  assert.equal(result.expertId,'astra');assert.equal(result.arguments.after_cursor,2);
});
