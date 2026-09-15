import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
async function run(t,text,env={}){
 const root=await mkdtemp(path.join(tmpdir(),'board-preflight-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'node.json');await writeFile(file,text);
 const mod=await import('./node_preflight.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
 assert.equal(typeof mod.inspectNodeConfiguration,'function','preflight entry point required');
 return mod.inspectNodeConfiguration({file,env});
}
const text=JSON.stringify({version:1,board_chat_id:-1001234567890,
 desktop:{executor_thread_id:'11111111-1111-4111-8111-111111111111'},
 agents:[{id:'participant',username:'participant_bot',token_env:'PARTICIPANT_BOT_TOKEN',
 backend:'codex-desktop',thread_id:'11111111-1111-4111-8111-111111111111'}]});
test('preflight reports missing credentials without treating it as a live deployment',async t=>{
 const result=await run(t,text);
 assert.equal(result.status,'needs-credentials');
 assert.deepEqual(result.missingCredentials,['PARTICIPANT_BOT_TOKEN']);
 assert.equal(result.liveVerified,false);
});
test('preflight returns safe public metadata, never token values',async t=>{
 const result=await run(t,text,{PARTICIPANT_BOT_TOKEN:'private-never-output'});
 assert.equal(result.status,'configuration-valid');
 assert.equal(result.participantCount,1);
 assert.equal(result.liveVerified,false);
 assert.ok(!JSON.stringify(result).includes('private-never-output'));
});
test('malformed JSON diagnostics do not echo credential-bearing source fragments',async t=>{
 const result=await run(t,'{"token":"private-never-output",BROKEN}');
 assert.equal(result.status,'invalid');
 assert.ok(!JSON.stringify(result).includes('private-never-output'));
});
