import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const {createTelegramBoardHub}=await import('./telegram_board_hub.mjs').catch(()=>({}));

test('shared hub imports existing journals without replay and journals observed sends once',async t=>{
  assert.equal(typeof createTelegramBoardHub,'function');
  const root=await mkdtemp(path.join(os.tmpdir(),'board-hub-'));
  let hub;
  t.after(async()=>{hub?.store.close();await rm(root,{recursive:true,force:true});});
  const configs=[{id:'astra',board:true,username:'astra',chatId:-1,token:'test-token'},
    {id:'peer',username:'peer',chatId:-1,token:'peer-token'}];
  const archive=path.join(root,'experts','peer','chat');await mkdir(archive,{recursive:true});
  const original={chat_id:-1,message_id:1,sender:'peer',sender_id:2,text:'old result',attachments:[]};
  await writeFile(path.join(archive,'messages.jsonl'),JSON.stringify(original)+'\n');
  let attempts=0;
  hub=await createTelegramBoardHub({configs,dataRoot:root,fetchImpl:async()=>{
    attempts++;return new Response(JSON.stringify({ok:true,result:{chat:{id:-1},message_id:2,from:{id:1,username:'astra',is_bot:true},text:'working'}}));
  }});
  assert.equal(hub.store.search({chatId:-1,query:'old'}).messages.length,1);
  const inbox=hub.inbox(configs[0],{getActiveTurnId:()=>null},async()=>assert.fail('old history replayed'));
  assert.equal(await inbox.tick(),'idle');
  await hub.telegram(configs[0]).sendText({chatId:-1,text:'working',deliveryKind:'status'});
  hub.archive({chat_id:-1,message_id:2,sender:'astra',sender_id:1,text:'working',attachments:[]});
  assert.equal(attempts,1);
  assert.equal(hub.store.lastSeq(),2);
  assert.equal(hub.store.readUpdates({chatId:-1,after:1}).messages.length,0);
  assert.equal(await createTelegramBoardHub({configs:[],dataRoot:root}),undefined);
});
