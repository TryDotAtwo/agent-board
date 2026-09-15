import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm,unlink} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
const token='123456789:'+ 'A'.repeat(35);
const config=()=>({version:1,board_chat_id:-1001234567890,
 desktop:{executor_thread_id:'11111111-1111-4111-8111-111111111111'},agents:[{
 id:'alice',username:'alice_bot',token_env:'ALICE_BOT_TOKEN',backend:'codex-desktop',thread_id:'11111111-1111-4111-8111-111111111111'}]});
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'provision-board-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function provision(args){
 const mod=await import('./provision_node.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
 assert.equal(typeof mod.provisionNode,'function','fresh-node provisioner required');return mod.provisionNode(args);
}
test('provisions only selected credentials and public node metadata without starting agents',async t=>{
 const root=await fixture(t);
 const result=await provision({root,config:config(),credentials:{ALICE_BOT_TOKEN:token,UNRELATED_SECRET:'never-copy'}});
 assert.equal(result.status,'configured');assert.equal(result.liveVerified,false);
 assert.ok(!JSON.stringify(result).includes(token));
 assert.deepEqual(JSON.parse(await readFile(path.join(root,'node.json'),'utf8')),config());
 const env=await readFile(path.join(root,'board.env'),'utf8');
 assert.equal(env,`ALICE_BOT_TOKEN=${token}\n`);
 assert.deepEqual((await readdir(root)).sort(),['board.env','node-install.json','node.json']);
});
test('identical retry is harmless; different chats or credentials cannot overwrite installation',async t=>{
 const root=await fixture(t),args={root,config:config(),credentials:{ALICE_BOT_TOKEN:token}};
 await provision(args);assert.equal((await provision(args)).status,'already-configured');
 const changed=config();changed.board_chat_id=-1009999999999;
 await assert.rejects(provision({...args,config:changed}),/different installation/i);
 await assert.rejects(provision({...args,credentials:{ALICE_BOT_TOKEN:token.replace(/A/g,'B')}}),/different installation/i);
 assert.equal(JSON.parse(await readFile(path.join(root,'node.json'),'utf8')).board_chat_id,-1001234567890);
});
test('retry resumes a verified partial installation without replacing credentials',async t=>{
 const root=await fixture(t),args={root,config:config(),credentials:{ALICE_BOT_TOKEN:token}};
 await provision(args);await unlink(path.join(root,'node.json'));
 assert.equal((await provision(args)).status,'configured');
 assert.equal(await readFile(path.join(root,'board.env'),'utf8'),`ALICE_BOT_TOKEN=${token}\n`);
});
test('validation failure leaves the target untouched and never echoes malformed secrets',async t=>{
 const root=await fixture(t);
 await assert.rejects(provision({root,config:config(),credentials:{ALICE_BOT_TOKEN:'secret\nNODE_OPTIONS=bad'}}),
  error=>!error.message.includes('secret')&&/credential/i.test(error.message));
 assert.deepEqual(await readdir(root),[]);
});
test('existing legacy configuration is never migrated by the fresh installer',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'experts.json'),'legacy-private');
 await assert.rejects(provision({root,config:config(),credentials:{ALICE_BOT_TOKEN:token}}),/existing deployment/i);
 assert.deepEqual(await readdir(root),['experts.json']);
});
test('concurrent incompatible provisioning cannot mix one node with another credential set',async t=>{
 const root=await fixture(t),first={root,config:config(),credentials:{ALICE_BOT_TOKEN:token}};
 const second={root,config:config(),credentials:{ALICE_BOT_TOKEN:token.replace(/A/g,'B')}};second.config.board_chat_id=-1009999999999;
 const results=await Promise.allSettled([provision(first),provision(second)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const winner=results[0].status==='fulfilled'?first:second;
 assert.equal(JSON.parse(await readFile(path.join(root,'node.json'),'utf8')).board_chat_id,winner.config.board_chat_id);
 assert.equal(await readFile(path.join(root,'board.env'),'utf8'),`ALICE_BOT_TOKEN=${winner.credentials.ALICE_BOT_TOKEN}\n`);
});
