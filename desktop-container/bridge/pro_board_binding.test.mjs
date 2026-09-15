import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('Pro board command is executed under Pro identity and continued in the same chat',async()=>{
  const mod=await import('./pro_board_binding.mjs').catch(()=>({}));
  assert.equal(typeof mod.createProClient,'function','Pro board runtime binding is missing');
  const root=await mkdtemp(path.join(tmpdir(),'pro-bind-'));
  const calls=[];
  const client=mod.createProClient({configs:[{id:'frontier_pro',backend:'desktop-chat',board:true}],
    root,pollMs:100000,boardHub:{service:{call:async input=>{calls.push(input);return {messages:[],nextCursor:7};}}}});
  try {
    await client.startOrResumeThread('frontier_pro',{chatThreadId:'pro-chat'});
    await client.startTurn('frontier_pro',[{type:'text',text:'Read the board'}]);
    const [file]=await readdir(path.join(root,'requests'));
    const request=JSON.parse(await readFile(path.join(root,'requests',file)));
    await writeFile(path.join(root,'results',file),JSON.stringify({...request,status:'completed',
      answer:JSON.stringify({telegram_board:{tool:'read_updates',arguments:{limit:5}}})}));
    await client.tick();
    assert.deepEqual(calls,[{expertId:'frontier_pro',tool:'read_updates',arguments:{limit:5}}]);
    assert.equal((await readdir(path.join(root,'requests'))).length,2);
    assert.equal(client.getThreadId('frontier_pro'),'pro-chat');
  } finally {client.close();await rm(root,{recursive:true,force:true});}
});
test('Pro research calls keep Pro identity and image payloads do not enter text continuations',async t=>{
 const {createProClient}=await import('./pro_board_binding.mjs');const root=await mkdtemp(path.join(tmpdir(),'pro-research-'));const calls=[];
 const client=createProClient({configs:[{id:'frontier_pro',backend:'desktop-chat',board:true}],root,pollMs:100000,
  boardHub:{service:{call:()=>assert.fail('research must not go to Telegram')}},research:{call:async x=>{calls.push(x);return {content:[{type:'text',text:'page snapshot'},{type:'image',data:'private-image-bytes'}]};}}});
 t.after(async()=>{client.close();await rm(root,{recursive:true,force:true});});
 await client.startOrResumeThread('frontier_pro',{chatThreadId:'chat'});await client.startTurn('frontier_pro',[{type:'text',text:'browse'}]);
 const [f]=await readdir(path.join(root,'requests'));const q=JSON.parse(await readFile(path.join(root,'requests',f)));
 assert.ok(q.prompt.length<9000);await mkdir(path.join(root,'results'),{recursive:true});
 await writeFile(path.join(root,'results',f),JSON.stringify({...q,status:'completed',answer:JSON.stringify({telegram_board:{tool:'browser_call',arguments:{name:'browser_snapshot',arguments:{}}}})}));
 await client.tick();assert.equal(calls[0].expertId,'frontier_pro');
 const next=(await readdir(path.join(root,'requests'))).find(x=>x!==f);const result=JSON.parse(await readFile(path.join(root,'requests',next)));
 assert.match(result.prompt,/page snapshot/);assert.ok(!result.prompt.includes('private-image-bytes'));
});
