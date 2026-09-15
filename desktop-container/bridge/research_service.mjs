import {mkdir,lstat,readFile,writeFile,readdir} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {ResearchJobs} from './research_jobs.mjs';
const string={type:'string'};const object={type:'object',additionalProperties:true};
const tool=(name,description,properties={},required=[])=>({name,description,inputSchema:{type:'object',properties,required}});
export const researchTools=[
 tool('research_capabilities','Current explicit access switches; contains no credentials.'),
 tool('browser_tools','Discover browser tool names and schemas; use name to retrieve a single schema.',{name:string}),
 tool('browser_artifact','Read a saved browser text snapshot/log. Use its filename relative to your browser output directory, not the displayed ../../ prefix.',{path:string,offset:{type:'integer',minimum:0}},['path']),
 tool('browser_call','Operate your own container browser using a discovered Playwright tool. Do not use disabled providers through alternative browser paths.',{name:string,arguments:object},['name']),
 tool('research_file','Read/write UTF-8 files or list your experiment workspace. Paths are relative; no Windows filesystem.',{action:{type:'string',enum:['read','write','list']},path:string,content:string,offset:{type:'integer',minimum:0}},['action']),
 tool('research_start','Start one experiment transport. Kaggle: CLI args, private publication by default. Molab: create session in enabled browser, acquire its exact URL/token, supply Python code. Never detach remote Molab work. Returns job ID; poll research_job. Reuse idempotency_key after uncertainty.',{service:{type:'string',enum:['kaggle','molab']},args:{type:'array',items:string},url:string,token:string,code:string,file:string,idempotency_key:string},['service','idempotency_key']),
 tool('research_job','Read experiment command status and a bounded output page. An uncertain job after restart must be inspected remotely, never blindly relaunched.',{id:string,offset:{type:'integer',minimum:0}},['id'])
];
export class ResearchService {
 constructor({root,env=process.env,browser,jobs,agentIds=['sol_ultra','frontier_pro']}){
  if(!Array.isArray(agentIds)||!agentIds.length||agentIds.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(id))||new Set(agentIds).size!==agentIds.length)
   throw new Error('Invalid research participant allowlist');
  Object.assign(this,{root,env,browser,jobs});this.agentIds=new Set(agentIds);this.managers=new Map();
 }
 capabilities(){return {browser:true,kaggle:!!this.env.KAGGLE_API_TOKEN?.trim(),molab:this.env.MOLAB_ENABLED==='true'};}
 async workspace(expertId){const dir=path.join(this.root,expertId,'workspace');await mkdir(dir,{recursive:true,mode:0o700});return dir;}
 async target(dir,name='.'){
  if(typeof name!=='string'||path.isAbsolute(name)||name.includes('\\')||name.split('/').includes('..'))throw new Error('Path must stay in the experiment workspace');
  const target=path.resolve(dir,name);if(target!==dir&&!target.startsWith(dir+path.sep))throw new Error('Invalid workspace path');
  let current=dir;for(const part of path.relative(dir,target).split(path.sep).filter(Boolean)){current=path.join(current,part);
   try{if((await lstat(current)).isSymbolicLink())throw new Error('Symlink paths are not allowed');}catch(e){if(e.code!=='ENOENT')throw e;}}
  return target;
 }
 async call({expertId,tool,arguments:args={}}){
  if(!this.agentIds.has(expertId))throw new Error('Unsupported research agent');
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Invalid arguments');
  const caps=this.capabilities();
  if(tool==='research_capabilities')return caps;
  if(tool==='browser_tools'){
   const tools=this.browser.toolsFor(expertId);return args.name?tools.find(t=>t.name===args.name)||{error:'unknown browser tool'}:tools.map(t=>({name:t.name,description:t.description?.slice(0,120)}));
  }
  if(tool==='browser_call'){
   if(args.name==='browser_navigate'){
    const host=new URL(args.arguments?.url).hostname;
    if((host==='molab.marimo.io'||host.endsWith('.molab.marimo.io'))&&!caps.molab)return {status:'disabled',service:'molab'};
   }
   return this.browser.call(expertId,args.name,args.arguments||{});
  }
  const cwd=await this.workspace(expertId);
  if(tool==='browser_artifact'){
   const target=await this.target(path.join(this.root,expertId),args.path);
   if((await lstat(target)).size>2000000)throw new Error('Artifact exceeds text budget');
   const text=await readFile(target,'utf8'),offset=args.offset??0;
   if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid offset');
   return {content:text.slice(offset,offset+6000),nextOffset:Math.min(offset+6000,text.length),size:text.length};
  }
  if(tool==='research_file'){
   const target=await this.target(cwd,args.path);
   if(args.action==='list')return {workspace:cwd,files:(await readdir(target,{withFileTypes:true})).slice(0,100).map(x=>({name:x.name,directory:x.isDirectory()}))};
   if(args.action==='write'){
    if(typeof args.content!=='string'||Buffer.byteLength(args.content)>100000)throw new Error('Content must be UTF-8 text up to 100KB');
    await mkdir(path.dirname(target),{recursive:true});await writeFile(target,args.content,{mode:0o600});return {path:target,bytes:Buffer.byteLength(args.content)};
   }
   if(args.action==='read'){
    if((await lstat(target)).size>2000000)throw new Error('File exceeds text reader budget');const value=await readFile(target,'utf8');const offset=args.offset??0;
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid offset');return {content:value.slice(offset,offset+6000),nextOffset:Math.min(offset+6000,value.length),size:value.length};
   }
   throw new Error('Unknown file operation');
  }
  let jobs=this.jobs||this.managers.get(expertId);if(!jobs){jobs=new ResearchJobs({root:path.join(this.root,expertId,'jobs')});this.managers.set(expertId,jobs);}
  if(tool==='research_job')return jobs.status(args.id,args.offset??0);
  if(tool!=='research_start')throw new Error('Unknown research tool');
  if(!['kaggle','molab'].includes(args.service))throw new Error('Unknown provider');
  if(!caps[args.service])return {status:'disabled',service:args.service};
  if(typeof args.idempotency_key!=='string'||!args.idempotency_key.trim()||args.idempotency_key.length>200)throw new Error('A stable idempotency_key is required');
  const id=createHash('sha256').update(expertId+'\0'+args.idempotency_key).digest('hex');
  const home=path.join(this.root,expertId,'auth-home');await mkdir(home,{recursive:true,mode:0o700});
  const env={PATH:'/opt/research/bin:/usr/local/bin:/usr/bin:/bin',HOME:home,LANG:'C.UTF-8',PYTHONUNBUFFERED:'1'};
  if(args.service==='kaggle'){
   if(!Array.isArray(args.args)||args.args.length>100||args.args.some(x=>typeof x!=='string'||x.includes('\0')))throw new Error('Kaggle args must be a string array');
   // Do not run auth/login/config commands: explicit token is the only adapter credential source.
   if(!['kernels','datasets','competitions','models'].includes(args.args[0]))throw new Error('Use Kaggle kernels/datasets/competitions/models commands; account login is not an experiment tool');
   return jobs.start(id,{command:'/opt/research/bin/kaggle',args:args.args,cwd,env:{...env,KAGGLE_API_TOKEN:this.env.KAGGLE_API_TOKEN,KAGGLE_CONFIG_DIR:home},secrets:[this.env.KAGGLE_API_TOKEN]});
  }
  const url=new URL(args.url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Use the exact HTTPS pairing base URL; pass its token separately');
  if(typeof args.token!=='string'||!args.token||typeof args.code!=='string'||args.code.length>100000)throw new Error('Molab needs the agent-acquired session token and Python code');
  return jobs.start(id,{command:'/bin/bash',args:['/opt/board/vendor/marimo-pair/execute-code.sh','--url',url.href.replace(/\/$/,''),...(args.file?['--file',args.file]:[]),'-'],input:args.code,cwd,env:{...env,MARIMO_TOKEN:args.token},secrets:[args.token]});
 }
}
