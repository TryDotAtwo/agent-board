import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
test('job replay launches once, redacts output, and retains final exit status',async t=>{
 const {ResearchJobs}=await import('./research_jobs.mjs').catch(()=>({}));assert.equal(typeof ResearchJobs,'function');
 const root=await mkdtemp(path.join(os.tmpdir(),'jobs-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const jobs=new ResearchJobs({root});const id='a'.repeat(64),counter=path.join(root,'counter');
 const spec={command:process.execPath,args:['-e',`require('fs').appendFileSync(${JSON.stringify(counter)},'x');console.log(process.env.SECRET);process.exit(3)`],env:{SECRET:'never-log-this'},cwd:root,secrets:['never-log-this']};
 await Promise.all([jobs.start(id,spec),jobs.start(id,spec)]);
 let result;for(let i=0;i<100;i++){result=await jobs.status(id);if(result.status==='completed')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(result.status,'completed');assert.equal(result.exitCode,3);assert.equal(await readFile(counter,'utf8'),'x');
 assert.ok(!result.output.includes('never-log-this'));assert.match(result.output,/REDACTED/);
 assert.equal((await new ResearchJobs({root}).status(id)).exitCode,3);
});
test('persisted unfinished jobs are uncertain after restart and never automatically relaunched',async t=>{
 const {ResearchJobs}=await import('./research_jobs.mjs').catch(()=>({}));assert.equal(typeof ResearchJobs,'function');
 const root=await mkdtemp(path.join(os.tmpdir(),'jobs-'));t.after(()=>rm(root,{recursive:true,force:true}));const id='b'.repeat(64);
 await writeFile(path.join(root,id+'.json'),JSON.stringify({id,status:'running'}));
 const jobs=new ResearchJobs({root});assert.equal((await jobs.start(id,{command:'/no-such-command'})).status,'uncertain');
});
test('live output does not expose a secret split across process chunks',async t=>{
 const {ResearchJobs}=await import('./research_jobs.mjs');const root=await mkdtemp(path.join(os.tmpdir(),'jobs-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const jobs=new ResearchJobs({root}),id='c'.repeat(64),secret='top-secret-value';
 await jobs.start(id,{command:process.execPath,args:['-e',"process.stdout.write('top-secret-');setTimeout(()=>console.log('value'),200)"],cwd:root,env:{},secrets:[secret]});
 let result;for(let i=0;i<100;i++){result=await jobs.status(id);assert.ok(!result.output.includes('top-secret-'));if(result.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(result.status,'completed');assert.match(result.output,/REDACTED/);
});

test('concurrent reuse of a job key with different work rejects the conflict, not returns another job',async t=>{
 const {ResearchJobs}=await import('./research_jobs.mjs');
 const root=await mkdtemp(path.join(os.tmpdir(),'jobs-conflict-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const jobs=new ResearchJobs({root}),id='d'.repeat(64),counter=path.join(root,'executed');
 const spec=letter=>({command:process.execPath,args:['-e',`require('fs').appendFileSync(${JSON.stringify(counter)},${JSON.stringify(letter)})`],cwd:root,env:{}});
 const results=await Promise.allSettled([jobs.start(id,spec('A')),jobs.start(id,spec('B'))]);
 let status;for(let i=0;i<100;i++){status=await jobs.status(id);if(status.status==='completed')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(status.status,'completed');
 assert.equal(await readFile(counter,'utf8'),'A');
 assert.equal(results[0].status,'fulfilled');
 assert.equal(results[1].status,'rejected');
 assert.match(results[1].reason.message,/conflict/i);
 await assert.rejects(jobs.start(id,spec('B')),/conflict/i);
 assert.equal((await jobs.start(id,spec('A'))).status,'completed');
 assert.equal(await readFile(counter,'utf8'),'A');
});
