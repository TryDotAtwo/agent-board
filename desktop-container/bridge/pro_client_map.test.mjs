import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
test('two Pro participants attach independent chats and keep separate durable spools',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'board-pro-map-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const mod=await import('./pro_board_binding.mjs');
 assert.equal(typeof mod.createProClientMap,'function','independent Pro clients are required');
 const configs=[{id:'bob',backend:'desktop-chat',board:true,proGatewayRoot:path.join(root,'bob')},
  {id:'carol',backend:'desktop-chat',board:true,proGatewayRoot:path.join(root,'carol')}];
 const clients=mod.createProClientMap({configs,boardHub:{service:{}},pollMs:100000});
 try{
  await clients.get('bob').startOrResumeThread('bob',{chatThreadId:'bob-chat'});
  await clients.get('carol').startOrResumeThread('carol',{chatThreadId:'carol-chat'});
  assert.equal(clients.get('bob').getThreadId('bob'),'bob-chat');
  assert.equal(clients.get('bob').getThreadId('carol'),undefined);
  assert.equal(clients.get('carol').getThreadId('carol'),'carol-chat');
  assert.notEqual(clients.get('bob').root,clients.get('carol').root);
 }finally{for(const client of clients.values())client.close();}
});
test('duplicate Pro spool roots fail before any clients run',async()=>{
 const mod=await import('./pro_board_binding.mjs');
 assert.equal(typeof mod.createProClientMap,'function');
 assert.throws(()=>mod.createProClientMap({configs:[
  {id:'bob',backend:'desktop-chat',board:true,proGatewayRoot:'/data/pro'},
  {id:'carol',backend:'desktop-chat',board:true,proGatewayRoot:'/data/pro'},
 ],boardHub:{service:{}}}),/spool/i);
});
