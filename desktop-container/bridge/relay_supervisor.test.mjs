import test from 'node:test';import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
test('each child receives its own gateway configuration overrides',async()=>{
 const {supervise}=await import('./relay_supervisor.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'relay-env-')),file=path.join(root,'result');
 const controller=new AbortController();
 const task=supervise({root,signal:controller.signal,pollMs:10,restartMs:10000,commands:[{name:'fixture',
  args:['-e','require("fs").writeFileSync(process.argv[1],process.env.BOARD_FIXTURE_VALUE||"missing")',file],env:{BOARD_FIXTURE_VALUE:'participant-specific'}}]});
 try{
  let result;const deadline=Date.now()+3000;
  while(Date.now()<deadline){result=await readFile(file,'utf8').catch(()=>undefined);if(result)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(result,'participant-specific');
 }finally{controller.abort();await task;await rm(root,{recursive:true,force:true});}
});
test('supervisor restarts a crashed child and stops its owned children on shutdown',async()=>{
 const {supervise}=await import('./relay_supervisor.mjs').catch(()=>({}));assert.equal(typeof supervise,'function');
 const root=await mkdtemp(path.join(tmpdir(),'relay-supervisor-')),counter=path.join(root,'counter');
 const controller=new AbortController();
 const program=`const fs=require('fs');const p=process.argv[1];const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));if(!n)process.exit(7);setInterval(()=>{},1000);`;
 const task=supervise({commands:[{name:'fixture',args:['-e',program,counter]}],root,signal:controller.signal,pollMs:20,restartMs:20});
 try{
  const deadline=Date.now()+5000;let count=0;
  while(Date.now()<deadline){count=Number(await readFile(counter,'utf8').catch(()=>0));if(count>=2)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(count,2);controller.abort();await task;
  const health=JSON.parse(await readFile(path.join(root,'relay-health.json'),'utf8'));assert.equal(health.status,'stopped');
 }finally{controller.abort();await task;await rm(root,{recursive:true,force:true});}
});
test('flock admits one owner and releases ownership when that owner exits',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'relay-lock-'));const lock=path.join(root,'owner.lock');
 const owner=spawn('/usr/bin/flock',['--nonblock',lock,process.execPath,'-e','console.log("locked");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
 try{
  await new Promise((resolve,reject)=>{owner.stdout.once('data',resolve);owner.once('error',reject);});
  assert.equal(spawnSync('/usr/bin/flock',['--nonblock',lock,'true']).status,1);
  // Terminate the fixture's Node child as well: flock keeps the lock in its child.
  const fixture=spawnSync('pgrep',['-P',String(owner.pid)],{encoding:'utf8'}).stdout.trim();
  if(fixture)process.kill(Number(fixture),'SIGTERM');
  await new Promise(resolve=>owner.exitCode!==null?resolve():owner.once('exit',resolve));
  assert.equal(spawnSync('/usr/bin/flock',['--nonblock',lock,'true']).status,0);
 }finally{owner.kill();await rm(root,{recursive:true,force:true});}
});
