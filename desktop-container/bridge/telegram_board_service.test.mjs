import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TelegramBoardStore} from './telegram_board_store.mjs';
const {TelegramBoardService}=await import('./telegram_board_service.mjs').catch(()=>({}));
const {createBoardFilePreparer}=await import('./board_file_snapshot.mjs').catch(()=>({}));

test('file snapshot preserves bytes and rejects sources outside the allowed root',async t=>{
  assert.equal(typeof createBoardFilePreparer,'function');
  const root=await mkdtemp(path.join(os.tmpdir(),'board-file-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source');await mkdir(source);
  const input=path.join(source,'proof.txt');await writeFile(input,'abc');
  const prepare=createBoardFilePreparer({outboxRoot:path.join(root,'outbox'),rootsFor:()=>[source]});
  const artifact=await prepare('peer',{path:input});
  assert.equal(artifact.sha256,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await writeFile(input,'changed');
  assert.equal(await readFile(artifact.path,'utf8'),'abc');
  const outside=path.join(root,'outside.txt');await writeFile(outside,'private');
  await assert.rejects(()=>prepare('peer',{path:outside}),/outside/);
  const secret=path.join(source,'.env');await writeFile(secret,'private');
  await assert.rejects(()=>prepare('peer',{path:secret}),/secret/);
});
async function fixture(t) {
  assert.equal(typeof TelegramBoardService,'function','board tools service is missing');
  const root=await mkdtemp(path.join(os.tmpdir(),'board-service-test-'));
  const store=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
  const sent=[];
  const configs=[{id:'astra',board:true,chatId:-1,username:'astra'}, {id:'pro',board:true,chatId:-2,username:'pro'}];
  const service=new TelegramBoardService({store,configs,attachmentRoots:[root],minPostIntervalMs:0,
    send:async(id,body)=>{sent.push([id,body]);return {message_id:sent.length+100,chat:{id:body.chatId},
      from:{id:99,username:id,is_bot:true},text:body.text,message_thread_id:body.topicId};}});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  return {root,store,service,sent};
}
test('tools enforce the configured chat and return new messages without blocking for answers',async t=>{
  const {service,store,sent}=await fixture(t);
  const result=await service.call({expertId:'astra',tool:'post_message',arguments:{text:'@peer question',idempotency_key:'q1',topic_id:10}});
  assert.equal(result.message_id,101);
  assert.equal(sent[0][1].chatId,-1);
  await service.call({expertId:'astra',tool:'post_message',arguments:{text:'@peer question',idempotency_key:'q1',topic_id:10}});
  assert.equal(sent.length,1);
  assert.equal((await service.call({expertId:'pro',tool:'read_updates',arguments:{}})).messages.length,0);
  await assert.rejects(()=>service.call({expertId:'other',tool:'read_updates',arguments:{}}),/not authorized/);
  await assert.rejects(()=>service.call({expertId:'astra',tool:'post_message',arguments:{text:'x',idempotency_key:'q2',reply_to:101,topic_id:20}}),/topic/);
  assert.equal(store.readUpdates({chatId:-1}).messages.length,1);
});
test('failed or ambiguous post is not automatically resent under the same key',async t=>{
  const {service,sent}=await fixture(t);
  service.send=async()=>{sent.push('attempt');throw new Error('network lost after send');};
  const args={expertId:'astra',tool:'post_message',arguments:{text:'question',idempotency_key:'lost'}};
  await assert.rejects(()=>service.call(args),/network/);
  await assert.rejects(()=>service.call(args),/pending|uncertain/i);
  assert.equal(sent.length,1);
});

test('post_file sends a registered snapshot once and retains the chosen reply target',async t=>{
  const {service,store,sent}=await fixture(t);
  store.append({chat_id:-1,message_id:7,sender:'peer',text:'question',attachments:[],message_thread_id:3});
  service.prepareFile=async()=>({artifactId:'snapshot-a',path:'/outbox/proof.txt',mimeType:'text/plain',size:3,sha256:'abc'});
  const request={expertId:'astra',tool:'post_file',arguments:{path:'/workspace/proof.txt',reply_to:7,idempotency_key:'file-a'}};
  const result=await service.call(request);
  assert.equal(result.message_id,101);
  assert.equal(sent[0][0],'astra');
  assert.equal(sent[0][1].chatId,-1);
  assert.equal(sent[0][1].replyTo,7);
  assert.equal(sent[0][1].topicId,3);
  assert.equal(sent[0][1].artifact.artifactId,'snapshot-a');
  service.prepareFile=async()=>{throw new Error('source changed; must reuse the saved snapshot');};
  await service.call(request);
  assert.equal(sent.length,1);
});
test('attachment pages are complete, hashed and confined to recorded allowed roots',async t=>{
  const {root,store,service}=await fixture(t);
  await writeFile(path.join(root,'proof.md'),'abcdef');
  store.append({chat_id:-1,message_id:1,text:'proof',sender:'alice',attachments:[
    {kind:'document',mime_type:'text/markdown',local_path:path.join(root,'proof.md')},
    {kind:'document',local_path:path.join(root,'..','outside.txt')},
  ]});
  const args={expertId:'astra',tool:'read_attachment',arguments:{message_id:1,attachment_index:0,offset:2,limit:3}};
  const page=await service.call(args);
  assert.equal(page.content,'cde');assert.equal(page.nextOffset,5);assert.equal(page.totalBytes,6);
  assert.match(page.sha256,/^[a-f0-9]{64}$/);
  const tail=await service.call({...args,arguments:{...args.arguments,offset:5}});
  assert.equal(tail.content,'f');assert.equal(tail.hasMore,false);
  await assert.rejects(()=>service.call({...args,arguments:{message_id:1,attachment_index:1}}),/outside|ENOENT/);
  await assert.rejects(()=>service.call({...args,expertId:'pro'}),/not found/);
});
