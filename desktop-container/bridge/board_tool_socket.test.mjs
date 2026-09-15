import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
test('socket binds the configured participant and refuses request identity overrides',async()=>{
 const mod=await import('./board_tool_socket.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'board-socket-'));
 const socket=path.join(root,'tools.sock');
 const server=await mod.startBoardToolSocket({socket,expertId:'alice',service:{call:async input=>({identity:input.expertId})}});
 try{
  assert.deepEqual(await mod.callBoardSocket(socket,{tool:'read_updates',arguments:{}}),{identity:'alice'});
  await assert.rejects(mod.callBoardSocket(socket,{expertId:'bob',tool:'read_updates'}));
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
test('private board socket dispatches only as Astra, never a supplied expert identity',async()=>{
 const mod=await import('./board_tool_socket.mjs').catch(()=>({}));
 assert.equal(typeof mod.startBoardToolSocket,'function','Desktop board tools are not connected');
 const root=await mkdtemp(path.join(tmpdir(),'board-socket-'));const socket=path.join(root,'tools.sock');
 const calls=[];const server=await mod.startBoardToolSocket({socket,service:{call:async x=>{calls.push(x);return {messages:[]};}}});
 try{assert.deepEqual(await mod.callBoardSocket(socket,{tool:'read_updates',arguments:{limit:1}}),{messages:[]});
 assert.deepEqual(calls,[{expertId:'sol_ultra',tool:'read_updates',arguments:{limit:1}}]);
 await assert.rejects(mod.callBoardSocket(socket,{expertId:'frontier_pro',tool:'read_updates',arguments:{}}));
 }finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
