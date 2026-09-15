import {spawn} from 'node:child_process';import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';import {createHash} from 'node:crypto';import {atomicJson} from './atomic_json.mjs';
const valid=id=>{if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid job ID');return id;};
export class ResearchJobs {
 constructor({root}){this.root=root;this.jobs=new Map();this.starting=new Map();}
 async start(id,spec){
  // Waiting for another caller is not proof that its operation matches ours.
  // Re-enter the durable fingerprint check before returning its job status.
  valid(id);if(this.starting.has(id)){await this.starting.get(id);return this.#start(id,spec);}
  const task=this.#start(id,spec);this.starting.set(id,task);
  try{return await task;}finally{this.starting.delete(id);}
 }
 async #start(id,spec){
  await mkdir(this.root,{recursive:true,mode:0o700});
  const file=path.join(this.root,id+'.json');
  const fingerprint=createHash('sha256').update(JSON.stringify([spec.command,spec.args,spec.input,spec.cwd])).digest('hex');
  try{const old=JSON.parse(await readFile(file,'utf8'));
   if(old.fingerprint&&old.fingerprint!==fingerprint)throw new Error('Job key conflicts with an earlier operation');return this.status(id);
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const record={id,fingerprint,status:'starting',startedAt:new Date().toISOString(),output:''};
  await atomicJson(file,record); // Intent precedes execution; restart never resubmits an uncertain remote operation.
  const ctx={record,raw:'',child:null};this.jobs.set(id,ctx);
  const redact=text=>{for(const secret of spec.secrets||[])if(secret)text=text.split(secret).join('[REDACTED]');return text;};
  const collect=chunk=>{ctx.raw=(ctx.raw+chunk).slice(-1048576);let safe=redact(ctx.raw);
   for(const secret of spec.secrets||[])for(let n=(secret?.length||0)-1;n>0;n--)if(safe.endsWith(secret.slice(0,n))){safe=safe.slice(0,-n)+'[REDACTED pending chunk]';break;}
   record.output=safe;};
  try{
   const child=spawn(spec.command,spec.args||[],{cwd:spec.cwd,env:spec.env,stdio:['pipe','pipe','pipe']});ctx.child=child;record.status='running';
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',collect);child.stderr.on('data',collect);
   child.once('error',()=>{record.error='process_start_failed';});
   child.once('close',(code,signal)=>{record.status='completed';record.exitCode=code;record.signal=signal;record.finishedAt=new Date().toISOString();
    ctx.saved=atomicJson(file,record).catch(()=>{record.error='result_persistence_failed';});});
   child.stdin.on('error',()=>{});child.stdin.end(spec.input||'');
  }catch{record.status='completed';record.error='process_start_failed';await atomicJson(file,record);}
  return {id,status:record.status};
 }
 async status(id,offset=0){
  valid(id);if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid output offset');
  const ctx=this.jobs.get(id);await ctx?.saved;
  const r=ctx?.record||JSON.parse(await readFile(path.join(this.root,id+'.json'),'utf8'));
  const output=r.output||'';return {id,status:!ctx&&['starting','running'].includes(r.status)?'uncertain':r.status,
   exitCode:r.exitCode,error:r.error,output:output.slice(offset,offset+6000),nextOffset:Math.min(offset+6000,output.length),outputTruncated:output.length>=1048576};
 }
}
