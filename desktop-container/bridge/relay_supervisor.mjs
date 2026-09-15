import {spawn} from 'node:child_process';import {readFile,open,mkdir,lstat,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';import net from 'node:net';
import {atomicJson} from './atomic_json.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function clearDeadProLock(root='/data/pro-gateway'){
 const file=`${root}/.pro-gateway.lock`;let lock;
 try{lock=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(!Number.isSafeInteger(lock.pid)||lock.pid<=1)throw new Error('Invalid gateway owner record');
 const cmd=await readFile(`/proc/${lock.pid}/cmdline`,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
 if(cmd.split('\0').includes('/opt/board/pro_gateway_runner.mjs'))throw new Error('Existing gateway owner is still running');
 await unlink(file);
}
async function clearDeadBoardSocket(file='/data/telegram-board/tools.sock'){
 let info;
 try{info=await lstat(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(!info.isSocket())throw new Error('Board socket path is not a socket');
 const live=await new Promise((resolve,reject)=>{
  const c=net.createConnection(file);c.once('connect',()=>{c.destroy();resolve(true)});
  c.once('error',e=>['ECONNREFUSED','ENOENT'].includes(e.code)?resolve(false):reject(e));
 });
 if(live)throw new Error('Existing board server is still running');
 await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
}
export async function supervise({commands,root='/data',signal,pollMs=1000,restartMs=5000}){
 await mkdir(root,{recursive:true});const states=commands.map(command=>({command,child:null,next:0,starts:0}));
 const status=async value=>atomicJson(`${root}/relay-health.json`,{status:value,pid:process.pid,updatedAt:new Date().toISOString(),
  children:states.map(s=>({name:s.command.name,pid:s.child?.pid??null,starts:s.starts,error:s.error??null}))});
 try{
  while(!signal?.aborted){
   for(const s of states)if(!s.child&&Date.now()>=s.next){
    try{
     await s.command.prepare?.();const output=await open(`${root}/${s.command.name}-runner.log`,'a',0o600);
     const child=spawn(process.execPath,s.command.args,{stdio:['ignore',output.fd,output.fd],env:{...process.env,...s.command.env}});
     s.child=child;s.starts++;s.error=null;
     const exited=()=>{if(s.child===child){s.child=null;s.next=Date.now()+restartMs;}};
     child.once('error',()=>{s.error='spawn_failed';exited();});child.once('exit',exited);
     await output.close();
    }catch{s.error='owner_or_startup_blocked';s.next=Date.now()+restartMs;}
   }
   await status(states.every(s=>s.child)?'running':'starting');await delay(pollMs);
  }
 }finally{
  const children=states.map(s=>s.child).filter(Boolean);
  for(const c of children)c.kill('SIGTERM');
  await Promise.all(children.map(async c=>{
   const end=Date.now()+10000;while(c.exitCode===null&&c.signalCode===null&&Date.now()<end)await delay(50);
   if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');
  }));
  await status('stopped');
 }
}
export function relayCommands(env=process.env){
 const sockets=env.BOARD_TOOL_SOCKETS?JSON.parse(env.BOARD_TOOL_SOCKETS):['/data/telegram-board/tools.sock'];
 if(!Array.isArray(sockets)||sockets.some(s=>typeof s!=='string'||!/^\/data\/telegram-board\/tools(?:-[a-z][a-z0-9_-]{0,63})?\.sock$/.test(s)))throw new Error('Invalid board socket cleanup bindings');
 let pro;
 if(env.BOARD_PRO_GATEWAYS){
  const gateways=JSON.parse(env.BOARD_PRO_GATEWAYS);
  if(!Array.isArray(gateways))throw new Error('Invalid gateway bindings');
  const ids=new Set(),threads=new Set();
  pro=gateways.map(g=>{
   if(!g||typeof g.id!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(g.id)||g.root!==`/data/pro-gateway/${g.id}`||
    typeof g.threadId!=='string'||!/^[a-f0-9-]{36}$/i.test(g.threadId)||ids.has(g.id)||threads.has(g.threadId))throw new Error('Invalid gateway bindings');
   ids.add(g.id);threads.add(g.threadId);
   return {name:`pro-${g.id}`,args:['/opt/board/pro_gateway_runner.mjs'],prepare:()=>clearDeadProLock(g.root),
    env:{PRO_CHAT_THREAD_ID:g.threadId,PRO_GATEWAY_ROOT:g.root}};
  });
 }else pro=env.PRO_CHAT_THREAD_ID?[{name:'pro',args:['/opt/board/pro_gateway_runner.mjs'],prepare:()=>clearDeadProLock()}]:[];
 return [
  ...pro,
  {name:'board',args:['--env-file=/data/board.env','/opt/board/board_entry.mjs'],prepare:async()=>{for(const socket of sockets)await clearDeadBoardSocket(socket);}}
 ];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const controller=new AbortController();for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>controller.abort());
 await supervise({signal:controller.signal,commands:relayCommands()});
}
