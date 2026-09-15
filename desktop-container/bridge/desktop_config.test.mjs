import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {desktopConfig} from './desktop_config.mjs';
test('new node bootstrap discovers every configured gateway without existing legacy files',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'board-node-bootstrap-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=path.join(root,'server.mjs');await writeFile(server,'');
 const executor='11111111-1111-4111-8111-111111111111';
 await writeFile(path.join(root,'node.json'),JSON.stringify({version:1,board_chat_id:-1001234567890,
  desktop:{executor_thread_id:executor},agents:[
   {id:'bob',username:'bob_bot',token_env:'BOB_TOKEN',backend:'chatgpt-desktop',thread_id:'22222222-2222-4222-8222-222222222222'},
   {id:'carol',username:'carol_bot',token_env:'CAROL_TOKEN',backend:'chatgpt-desktop',thread_id:'33333333-3333-4333-8333-333333333333'}]}));
 const result=await desktopConfig(root,{explicit:server});
 assert.equal(result.astraThreadId,executor);
 assert.equal(result.gateways.length,2);
 assert.equal(result.gateways[0].root,path.join(root,'pro-gateway','bob'));
 assert.equal(result.gateways[1].threadId,'33333333-3333-4333-8333-333333333333');
 assert.deepEqual(result.boardSockets,[]);
});
test('a standalone named Codex participant can bootstrap without a Pro conversation',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'board-single-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const server=path.join(root,'server.mjs');await writeFile(server,'');
 await mkdir(path.join(root,'experts/alice'),{recursive:true});
 await writeFile(path.join(root,'experts/alice/state.json'),JSON.stringify({threadId:'33333333-3333-4333-8333-333333333333'}));
 await writeFile(path.join(root,'experts.json'),JSON.stringify({experts:[{id:'alice',backend:'codex',board:true}]}));
 const result=await desktopConfig(root,{explicit:server});
 assert.equal(result.astraThreadId,'33333333-3333-4333-8333-333333333333');
 assert.equal(result.proThreadId,undefined);
 assert.equal(result.executorId,'alice');
});

test('bootstrap preserves configured chats and resolves tools from the installation home', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'board-config-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home');
  const server=path.join(home,'.codex/plugins/cache/openai-bundled/codex-app-tools/9.8.7/server.mjs');
  await mkdir(path.dirname(server),{recursive:true}); await writeFile(server,'');
  await mkdir(path.join(root,'experts/sol_ultra'),{recursive:true});
  await writeFile(path.join(root,'experts/sol_ultra/state.json'),JSON.stringify({threadId:'11111111-1111-4111-8111-111111111111'}));
  await writeFile(path.join(root,'experts.json'),JSON.stringify({experts:[
    {id:'sol_ultra',board:true},
    {id:'frontier_pro',board:true,chat_thread_id:'22222222-2222-4222-8222-222222222222'},
  ]}));
  const result=await desktopConfig(root,{home,explicit:''});
  assert.equal(result.astraThreadId,'11111111-1111-4111-8111-111111111111');
  assert.equal(result.proThreadId,'22222222-2222-4222-8222-222222222222');
  assert.equal(result.serverPath,server);
});
