import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'board-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'node.json'),JSON.stringify({version:1,board_chat_id:-1001234567890,desktop:{executor_thread_id:ids[0]},
  agents:[{id:'alice',username:'alice_bot',token_env:'ALICE_TOKEN',backend:'codex-desktop',thread_id:ids[0]},
   {id:'bob',username:'bob_bot',token_env:'BOB_TOKEN',backend:'chatgpt-desktop',thread_id:ids[1]},
   {id:'carol',username:'carol_bot',token_env:'CAROL_TOKEN',backend:'chatgpt-desktop',thread_id:ids[2]}]}));
 return {root,env:{ALICE_TOKEN:'one',BOB_TOKEN:'two',CAROL_TOKEN:'three'}};
}
async function load(options){
 const mod=await import('./runtime_configuration.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
 assert.equal(typeof mod.loadRuntimeConfiguration,'function','runtime config loader required');
 return mod.loadRuntimeConfiguration(options);
}
test('runtime consumes node JSON and binds permanent chats without creating private state',async t=>{
 const f=await fixture(t),r=await load(f);
 assert.equal(r.portable,true);assert.deepEqual(r.configs.map(c=>c.id),['alice','bob','carol']);
 assert.deepEqual(r.configs.map(c=>c.initialThreadId),ids);
 assert.equal(r.configs[0].backend,'codex');assert.equal(r.configs[1].backend,'desktop-chat');
 assert.equal(r.configs[0].model,undefined);assert.equal(r.configs[0].developerInstructions,undefined);
 assert.equal(r.configs[0].token,'one');
 assert.equal(r.configs[0].boardSocket,path.join(f.root,'telegram-board','tools-alice.sock'));
 assert.notEqual(r.configs[1].proGatewayRoot,r.configs[2].proGatewayRoot);
 const {readdir}=await import('node:fs/promises');assert.deepEqual(await readdir(f.root),['node.json']);
});
test('Desktop startup can discover configured sessions before loading private credentials',async t=>{
 const f=await fixture(t),r=await load({root:f.root,env:{},requireCredentials:false});
 assert.equal(r.node.executorThreadId,ids[0]);assert.equal(r.configs[0].token,undefined);
});
test('invalid explicit node configuration never falls back to another deployment',async t=>{
 const f=await fixture(t);
 await assert.rejects(load({root:f.root,env:{...f.env,BOARD_NODE_CONFIG:path.join(f.root,'missing.json')}}),/ENOENT/);
});
