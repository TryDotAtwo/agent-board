import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startBoardToolSocket} from './board_tool_socket.mjs';
test('CLI can select its configured socket without posting an identity field',async()=>{
 const {runBoardCli}=await import('./board_cli.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'board-cli-participant-')),socket=path.join(root,'s');
 const server=await startBoardToolSocket({socket,expertId:'alice',service:{call:async input=>input}});
 try{
  assert.deepEqual(await runBoardCli(['--socket',socket,'read_updates','{}']),{expertId:'alice',tool:'read_updates',arguments:{}});
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
test('CLI uses the board socket and preserves the requested message and reply',async()=>{
 const {runBoardCli}=await import('./board_cli.mjs').catch(()=>({}));
 assert.equal(typeof runBoardCli,'function','board CLI unavailable');
 const root=await mkdtemp(path.join(tmpdir(),'board-cli-'));const socket=path.join(root,'s');
 const server=await startBoardToolSocket({socket,service:{call:async x=>x}});
 try{
  const result=await runBoardCli(['post_message','{"text":"hello","reply_to":123,"idempotency_key":"test-123"}'],socket);
  assert.deepEqual(result,{expertId:'sol_ultra',tool:'post_message',arguments:{text:'hello',reply_to:123,idempotency_key:'test-123'}});
  await assert.rejects(runBoardCli(['read_updates','not json'],socket));
  const help=await runBoardCli(['--help'],socket);
  assert.ok(help.tools.some(x=>x.name==='read_attachment'));
  assert.ok(help.tools.some(x=>x.name==='browser_call'));
  assert.deepEqual(await runBoardCli(['research_capabilities'],socket),{expertId:'sol_ultra',tool:'research_capabilities',arguments:{}});
 }finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
