import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,mkdir,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
async function setup(t,env={}){
 const {ResearchService}=await import('./research_service.mjs').catch(()=>({}));assert.equal(typeof ResearchService,'function');
 const root=await mkdtemp(path.join(os.tmpdir(),'research-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const launches=[];const service=new ResearchService({root,env,jobs:{start:async(id,spec)=>{launches.push({id,spec});return {id,status:'running'}},status:async()=>({status:'done'})},browser:{toolsFor:()=>[],call:async()=>({content:[]})}});
 return {service,launches,root,call:(tool,args={},expertId='sol_ultra')=>service.call({expertId,tool,arguments:args})};
}
test('missing consent prevents remote job launch and token values never enter capabilities',async t=>{
 const {call,launches}=await setup(t);
 for(const service of ['kaggle','molab'])assert.equal((await call('research_start',{service,idempotency_key:'a'})).status,'disabled');
 assert.equal(launches.length,0);assert.equal((await call('research_capabilities')).molab,false);
 const enabled=await setup(t,{KAGGLE_API_TOKEN:'secret-test-value',MOLAB_ENABLED:'true'});
 assert.deepEqual(await enabled.call('research_capabilities'),{browser:true,kaggle:true,molab:true});
 assert.ok(!JSON.stringify(await enabled.call('research_capabilities')).includes('secret-test-value'));
});
test('Kaggle receives only explicit token and fixed private cwd; Molab requires enablement not a preset token',async t=>{
 const {call,launches,root}=await setup(t,{KAGGLE_API_TOKEN:'provided',MOLAB_ENABLED:'true',TELEGRAM_TOKEN:'never-pass'});
 await call('research_start',{service:'kaggle',args:['kernels','status','owner/test'],idempotency_key:'one'});
 assert.equal(launches[0].spec.command,'/opt/research/bin/kaggle');assert.equal(launches[0].spec.env.KAGGLE_API_TOKEN,'provided');
 assert.equal(launches[0].spec.env.TELEGRAM_TOKEN,undefined);assert.equal(launches[0].spec.cwd,path.join(root,'sol_ultra','workspace'));
 await call('research_start',{service:'molab',url:'https://session.example.org',token:'generated-by-agent',code:'print(1)',idempotency_key:'two'});
 assert.equal(launches[1].spec.env.MARIMO_TOKEN,'generated-by-agent');assert.ok(!launches[1].spec.args.includes('generated-by-agent'));
 assert.equal(launches[1].spec.input,'print(1)');
});
test('workspace separates agents and rejects traversal and symlink escapes',async t=>{
 const {call,root}=await setup(t);
 await call('research_file',{action:'write',path:'experiment.py',content:'print(42)'});
 assert.equal((await call('research_file',{action:'read',path:'experiment.py'})).content,'print(42)');
 await assert.rejects(call('research_file',{action:'read',path:'experiment.py'},'frontier_pro'));
 await assert.rejects(call('research_file',{action:'write',path:'../escape',content:'x'}));
 await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(root,'sol_ultra','workspace','link'));
 await assert.rejects(call('research_file',{action:'write',path:'link/escape',content:'x'}));
 await assert.rejects(call('research_capabilities',{},'other'));
});
test('text-only Pro can read its browser snapshot files without accessing another agent profile',async t=>{
 const {call,root}=await setup(t);await mkdir(path.join(root,'frontier_pro'),{recursive:true});
 await writeFile(path.join(root,'frontier_pro','page.yml'),'button Submit');
 assert.equal((await call('browser_artifact',{path:'page.yml'},'frontier_pro')).content,'button Submit');
 await assert.rejects(call('browser_artifact',{path:'../sol_ultra/page.yml'},'frontier_pro'));
});
