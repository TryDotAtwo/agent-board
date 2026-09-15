import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root=await mkdtemp(path.join(os.tmpdir(),'board-upload-'));
process.env.OUTBOX_ROOT=path.join(root,'outbox');
const {createTelegramBoardHub}=await import('./telegram_board_hub.mjs');
test('board file reaches sendDocument with snapshot bytes and only one network send',async t=>{
 let hub; t.after(async()=>{hub?.store.close();await rm(root,{recursive:true,force:true});});
 const source=path.join(root,'research','peer');await mkdir(source,{recursive:true});
 const file=path.join(source,'proof.txt');await writeFile(file,'abc');let sends=0;
 hub=await createTelegramBoardHub({dataRoot:root,configs:[{id:'peer',username:'peer_bot',board:true,chatId:-1,token:'test'}],
  fetchImpl:async(url,options)=>{
   sends++;assert.ok(url.endsWith('/sendDocument'));
   assert.equal(options.body.get('chat_id'),'-1');
   assert.equal(await options.body.get('document').text(),'abc');
   assert.equal(JSON.parse(options.body.get('reply_parameters')).message_id,7);
   return new Response(JSON.stringify({ok:true,result:{message_id:8,chat:{id:-1},from:{id:2,is_bot:true,username:'peer_bot'},document:{file_id:'f',file_unique_id:'u',file_name:'proof.txt',mime_type:'text/plain',file_size:3}}}));
  }});
 hub.store.append({chat_id:-1,message_id:7,sender:'owner',text:'question',attachments:[]});
 const request={expertId:'peer',tool:'post_file',arguments:{path:file,reply_to:7,idempotency_key:'upload-a'}};
 assert.equal((await hub.service.call(request)).message_id,8);
 await writeFile(file,'changed');await hub.service.call(request);
 assert.equal(sends,1);assert.equal(hub.store.getMessage(-1,8).attachments.length,1);
 const uploaded=await hub.service.call({expertId:'peer',tool:'read_attachment',arguments:{message_id:8,attachment_index:0}});
 assert.equal(uploaded.content,'abc');
 assert.equal(uploaded.sha256,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 hub.service.minPostIntervalMs=0;
 const prepare=hub.service.prepareFile;
 hub.service.prepareFile=async(...args)=>{const artifact=await prepare(...args);await writeFile(artifact.path,'mutated');return artifact;};
 await assert.rejects(()=>hub.service.call({...request,arguments:{...request.arguments,idempotency_key:'tampered'}}),/hash/i);
 assert.equal(sends,1);
});
