import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('addressed input joins an existing research turn and completes while the goal continues',async t=>{
 const {DesktopCodexClient}=await import('./desktop_codex_client.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'desktop-research-steer-'));
 let data={thread:{id:'research',status:{type:'running'}},turns:[{id:'ongoing',status:'inProgress',items:[
  {type:'agentMessage',id:'old',phase:'final_answer',text:'Earlier result'}]}]};
 const sent=[],clients=[];
 const mcp={start:async()=>{},close(){},readThread:async()=>({content:[{type:'text',text:JSON.stringify(data)}]}),
  sendMessage:async text=>{sent.push(text);data.turns[0].items.push({type:'userMessage',content:[{type:'text',text}]});}};
 const open=async()=>{const c=new DesktopCodexClient({root,clientFactory:()=>mcp,pollMs:100000});clients.push(c);await c.startOrResumeThread('peer',{threadId:'research'});return c;};
 t.after(async()=>{clients.forEach(c=>c.close());await rm(root,{recursive:true,force:true});});
 let c=await open();const input=[{type:'text',text:'A direct question'}];
 const first=await c.startTurn('peer',input,{allowActive:true});c.close();
 c=await open();assert.equal((await c.startTurn('peer',input,{allowActive:true})).id,first.id);
 assert.deepEqual(sent,['A direct question']);
 const finals=[];c.on('turnCompleted',x=>finals.push(x));
 await c.tick();assert.equal(finals.length,0);
 data.turns[0].items.push({type:'agentMessage',id:'answer',phase:'final_answer',text:'The answer'});
 data.turns[0].status='completed';data.turns[0].completedAt=123;
 data.turns.push({id:'goal-next',status:'inProgress',items:[]});
 await c.tick();assert.equal(finals.length,1);assert.equal(finals[0].finalAnswer,'The answer');
});
test('live Desktop busy status overrides interrupted history from a separate reader',async()=>{
 const {DesktopCodexClient}=await import('./desktop_codex_client.mjs');
 const c=new DesktopCodexClient({clientFactory:()=>{}});
 const ctx={threadId:'astra',reader:{request:async()=>({thread:{id:'astra',turns:[{id:'active',status:'interrupted',items:[]}]}})},
  mcp:{readThread:async()=>({content:[{type:'text',text:JSON.stringify({thread:{id:'astra',status:{type:'running'}},turns:[]})}]})}};
 const result=await c.snapshot(ctx);
 assert.equal(result.thread.status.type,'running');
 assert.equal(result.turns[0].id,'active');
});
test('native sender rejects absent Desktop tools instead of guessing a version-specific path',async()=>{
  const {DesktopCodexClient}=await import('./desktop_codex_client.mjs');
  const root=await mkdtemp(path.join(tmpdir(),'desktop-uninstalled-'));
  const previous=process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID='source-task';
  const client=new DesktopCodexClient({root,serverOptions:{home:root,explicit:''}});
  try {
    await assert.rejects(Promise.resolve().then(()=>client.clientFactory('target-task')),/not installed/i);
  }finally{
    client.close();
    if(previous===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=previous;
    await rm(root,{recursive:true,force:true});
  }
});
test('Desktop owns Astra; bridge steers, relays commentary once, and resumes uncertain sends without duplication',async()=>{
  const mod=await import('./desktop_codex_client.mjs').catch(()=>({}));
  assert.equal(typeof mod.DesktopCodexClient,'function','Desktop-native transport is missing');
  const root=await mkdtemp(path.join(tmpdir(),'desktop-codex-'));
  let snapshot={thread:{id:'astra',status:{type:'idle'}},turns:[]};
  const sent=[];
  const mcp={start:async()=>{},close(){},readThread:async()=>({content:[{type:'text',text:JSON.stringify(snapshot)}]}),
    sendMessage:async text=>{sent.push(text);}};
  let c=new mod.DesktopCodexClient({root,clientFactory:()=>mcp,pollMs:100000});
  const options={threadId:'astra'};
  try {
    await c.start();await c.startOrResumeThread('sol_ultra',options);
    const turn=await c.startTurn('sol_ultra',[{type:'text',text:'question'}]);
    await c.steerTurn('sol_ultra',[{type:'text',text:'correction'}]);
    await c.steerTurn('sol_ultra',[{type:'text',text:'correction'}]);
    assert.deepEqual(sent,['question','correction']);
    c.close();
    c=new mod.DesktopCodexClient({root,clientFactory:()=>mcp,pollMs:100000});
    await c.startOrResumeThread('sol_ultra',options);
    const resumed=await c.startTurn('sol_ultra',[{type:'text',text:'question'}]);
    assert.equal(resumed.id,turn.id);assert.equal(sent.length,2);
    const comments=[],finals=[];
    c.on('commentary',x=>comments.push(x.text));c.on('turnCompleted',x=>finals.push(x));
    snapshot={thread:{id:'astra',status:{type:'running'}},turns:[{id:'native-turn',status:'inProgress',items:[
      {type:'functionCallOutput',name:'send_message_to_thread',output:'<codex_delegation>\n  <source_thread_id>astra</source_thread_id>\n  <input>question</input>\n</codex_delegation>'},
      {type:'agentMessage',id:'c1',phase:'commentary',text:'Finding'}]}]};
    await c.tick();await c.tick();assert.deepEqual(comments,['Finding']);assert.equal(finals.length,0);
    snapshot.thread.status.type='idle';snapshot.turns[0].status='completed';
    snapshot.turns[0].items.push({type:'agentMessage',id:'f1',phase:'final_answer',text:'Answer'});
    await c.tick();assert.equal(finals[0].finalAnswer,'Answer');assert.equal(finals[0].id,turn.id);
  }finally{c.close();await rm(root,{recursive:true,force:true});}
});
