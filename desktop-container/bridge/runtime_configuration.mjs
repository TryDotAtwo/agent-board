import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseNodeConfig} from './node_config.mjs';
import {parseExpertConfigs} from './expert_config.mjs';

export async function loadRuntimeConfiguration({root='/data',env=process.env,requireCredentials=true}={}){
 const nodeFile=env.BOARD_NODE_CONFIG||path.join(root,'node.json');
 let nodeRaw;
 try{nodeRaw=await readFile(nodeFile,'utf8');}
 catch(error){if(error.code!=='ENOENT'||env.BOARD_NODE_CONFIG)throw error;}
 if(nodeRaw!==undefined){
  let input;try{input=JSON.parse(nodeRaw);}catch{throw new Error('Invalid node configuration JSON');}
  const node=parseNodeConfig(input,{env,requireCredentials});
  const configs=node.agents.map(agent=>({
   id:agent.id,username:agent.username,token:env[agent.tokenEnv]?.trim(),
   backend:agent.backend==='codex-desktop'?'codex':'desktop-chat',board:true,chatId:node.boardChatId,
   initialThreadId:agent.threadId,chatThreadId:agent.backend==='chatgpt-desktop'?agent.threadId:undefined,
   cwd:`/workspace/${agent.id}`,accessMode:'container-full',toolNamespaces:[],
   boardSocket:path.join(root,'telegram-board',`tools-${agent.id}.sock`),
   proGatewayRoot:agent.backend==='chatgpt-desktop'?path.join(root,'pro-gateway',agent.id):undefined,
  }));
  return {portable:true,node,configs};
 }
 const configRaw=env.EXPERTS_CONFIG?await readFile(env.EXPERTS_CONFIG,'utf8'):undefined;
 const configs=parseExpertConfigs({raw:configRaw,env});
 for(const config of configs){
  config.boardSocket=path.join(root,'telegram-board',config.id==='sol_ultra'?'tools.sock':`tools-${config.id}.sock`);
  if(config.backend==='desktop-chat')config.proGatewayRoot=env.PRO_GATEWAY_ROOT||path.join(root,'pro-gateway');
 }
 return {portable:false,configs,configRaw};
}
