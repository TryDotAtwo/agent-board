import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtemp,stat,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';import path from 'node:path';import {tmpdir} from 'node:os';
test('stdin installer hides credentials, writes private files and is repeatable',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'board-provision-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const token='123456789:'+ 'A'.repeat(35);
 const input=JSON.stringify({config:{version:1,board_chat_id:-1001234567890,
  desktop:{executor_thread_id:'11111111-1111-4111-8111-111111111111'},agents:[{id:'alice',username:'alice_bot',token_env:'ALICE_BOT_TOKEN',
   backend:'codex-desktop',thread_id:'11111111-1111-4111-8111-111111111111'}]},credentials:{ALICE_BOT_TOKEN:token}});
 const command=[fileURLToPath(new URL('./provision_node.mjs',import.meta.url)),root];
 const first=spawnSync(process.execPath,command,{input,encoding:'utf8'});
 assert.equal(first.status,0,first.stderr);assert.equal(first.stderr,'');
 assert.equal(JSON.parse(first.stdout).status,'configured');assert.ok(!first.stdout.includes(token));
 const retry=spawnSync(process.execPath,command,{input,encoding:'utf8'});
 assert.equal(retry.status,0,retry.stderr);assert.equal(JSON.parse(retry.stdout).status,'already-configured');
 if(process.platform!=='win32')for(const name of ['board.env','node.json','node-install.json'])
  assert.equal((await stat(path.join(root,name))).mode&0o777,0o600);
 const bad=spawnSync(process.execPath,command,{input:'{"secret":"never-output",malformed}',encoding:'utf8'});
 assert.equal(bad.status,1);assert.ok(!(bad.stdout+bad.stderr).includes('never-output'));
});
