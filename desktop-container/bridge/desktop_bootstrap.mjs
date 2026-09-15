import {spawn} from 'node:child_process';import {open} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {desktopConfig} from './desktop_config.mjs';
export function bootstrapContext(event,env,config){
 if(!['SessionStart','UserPromptSubmit'].includes(event.hook_event_name)||event.session_id!==config.astraThreadId)return null;
 if(!env.CODEX_APP_TOOLS_PIPE_PATH)throw new Error('Genuine Desktop context is absent');
 // Identity comes from the documented event emitted by the real Desktop executor.
 return {...env,CODEX_THREAD_ID:event.session_id,PRO_CHAT_THREAD_ID:config.proThreadId,
  PRO_GATEWAY_ROOT:'/data/pro-gateway',PRO_DESKTOP_MCP_SERVER:config.serverPath,
  BOARD_PRO_GATEWAYS:config.gateways?JSON.stringify(config.gateways):undefined,
  BOARD_TOOL_SOCKETS:config.boardSockets?JSON.stringify(config.boardSockets):undefined};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>1000000)throw new Error('Oversized event');}
  const env=bootstrapContext(JSON.parse(raw),process.env,await desktopConfig());
  if(env){
   const output=await open('/data/relay-supervisor.log','a',0o600);
   const child=spawn('/usr/bin/flock',['--nonblock','/data/relay-supervisor.lock',process.execPath,
    '--env-file=/data/board.env','/opt/board/relay_supervisor.mjs'],{env,detached:true,stdio:['ignore',output.fd,output.fd]});
   child.unref();await output.close();
  }
 }catch{process.stderr.write('Desktop relay bootstrap unavailable; inspect container configuration.\n');process.exitCode=1;}
}
