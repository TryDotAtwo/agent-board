import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {discoverDesktopServer} from './desktop_server_path.mjs';
import {loadRuntimeConfiguration} from './runtime_configuration.mjs';
export async function desktopConfig(root='/data',serverOptions={}){
 const nodeFile=process.env.BOARD_NODE_CONFIG||path.join(root,'node.json');
 let hasNode=false;
 try{await access(nodeFile);hasNode=true;}catch(error){if(error.code!=='ENOENT'||process.env.BOARD_NODE_CONFIG)throw error;}
 if(hasNode){
  const {node,configs}=await loadRuntimeConfiguration({root,requireCredentials:false});
  return {astraThreadId:node.executorThreadId,serverPath:await discoverDesktopServer(serverOptions),
   gateways:configs.filter(c=>c.backend==='desktop-chat').map(c=>({id:c.id,threadId:c.chatThreadId,root:c.proGatewayRoot})),
   boardSockets:configs.filter(c=>c.backend==='codex').map(c=>c.boardSocket)};
 }
 const raw=JSON.parse(await readFile(`${root}/experts.json`,'utf8'));
 const pro=raw.experts.find(x=>x.board===true&&(x.backend==='desktop-chat'||(!x.backend&&x.id==='frontier_pro')));
 const astra=raw.experts.find(x=>x.board===true&&x!==pro&&(!x.backend||x.backend==='codex'));
 if(!astra||!/^[a-z][a-z0-9_-]{0,63}$/.test(astra.id))throw new Error('Configure a native Desktop participant as the local executor');
 const state=JSON.parse(await readFile(`${root}/experts/${astra.id}/state.json`,'utf8'));
 if(!state.threadId||(pro&&!pro.chat_thread_id))throw new Error('Configure existing Desktop chats first');
 if(!/^[a-f0-9-]{36}$/.test(state.threadId))throw new Error('Invalid Astra task ID');
 return {executorId:astra.id,astraThreadId:state.threadId,proThreadId:pro?.chat_thread_id,
  serverPath:await discoverDesktopServer(serverOptions)};
}
