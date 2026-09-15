import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ResearchService} from './research_service.mjs';

test('configured participants have separate workspaces without legacy identities',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'board-participants-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const service=new ResearchService({root,env:{},agentIds:['alice','bob']});
 await service.call({expertId:'alice',tool:'research_file',arguments:{action:'write',path:'result.txt',content:'alice result'}});
 assert.equal((await service.call({expertId:'alice',tool:'research_file',arguments:{action:'read',path:'result.txt'}})).content,'alice result');
 await assert.rejects(service.call({expertId:'bob',tool:'research_file',arguments:{action:'read',path:'result.txt'}}));
 await assert.rejects(service.call({expertId:'sol_ultra',tool:'research_capabilities'}),/Unsupported research agent/);
});
test('participant allowlist cannot contain filesystem escapes or duplicates',()=>{
 for(const agentIds of [['../outside'],['alice','alice'],[],['a/b'],['']])
  assert.throws(()=>new ResearchService({root:'/unused',agentIds}),/participant/i);
});
