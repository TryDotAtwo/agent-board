import {mkdir,lstat,readFile,open,link,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';import {pathToFileURL} from 'node:url';
import {parseNodeConfig} from './node_config.mjs';

async function existing(file){
 try{
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('Installation path is not a regular file');
  return await readFile(file,'utf8');
 }catch(error){if(error.code==='ENOENT')return undefined;throw error;}
}
async function present(file){try{await lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

// Install a complete file without replacing an existing directory entry.
async function immutableFile(file,content){
 const old=await existing(file);
 if(old!==undefined){if(old!==content)throw new Error('Existing installation content differs');return false;}
 const temp=path.join(path.dirname(file),`.provision-${randomUUID()}`);
 let handle;
 try{
  handle=await open(temp,'wx',0o600);await handle.writeFile(content);await handle.sync();await handle.close();handle=undefined;
  try{await link(temp,file);return true;}
  catch(error){if(error.code!=='EEXIST')throw error;
   if(await existing(file)!==content)throw new Error('Existing installation content differs');return false;}
 }finally{await handle?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

export async function provisionNode({root='/data',config,credentials}){
 if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('Installation root must be absolute');
 if(!credentials||typeof credentials!=='object'||Array.isArray(credentials))throw new Error('Credential mapping required');
 const parsed=parseNodeConfig(config,{env:credentials});
 const lines=[];
 for(const name of parsed.agents.map(a=>a.tokenEnv).sort()){
  const value=credentials[name].trim();
  if(!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(value))throw new Error('Invalid Telegram credential format');
  lines.push(`${name}=${value}\n`);
 }
 const normalized={version:1,board_chat_id:parsed.boardChatId,desktop:{executor_thread_id:parsed.executorThreadId},
  agents:parsed.agents.map(a=>({id:a.id,username:a.username,token_env:a.tokenEnv,backend:a.backend,thread_id:a.threadId}))};
 const metadata=JSON.stringify(normalized,null,2)+'\n',environment=lines.join('');
 const fingerprint=createHash('sha256').update(metadata).update('\0').update(environment).digest('hex');
 const marker=path.join(root,'node-install.json');
 const intent=JSON.stringify({version:1,fingerprint})+'\n';
 const previous=await existing(marker);
 if(previous!==undefined&&previous!==intent)throw new Error('A different installation already owns this data directory');
 if(previous===undefined){
  for(const name of ['experts.json','node.json','board.env','experts','telegram-board','pro-gateway'])
   if(await present(path.join(root,name)))throw new Error('Existing deployment detected; use explicit migration, not fresh provisioning');
 }
 await mkdir(root,{recursive:true,mode:0o700});
 await immutableFile(marker,intent);
 await immutableFile(path.join(root,'board.env'),environment);
 // Publish configuration last: startup cannot see a node with incomplete credentials.
 const created=await immutableFile(path.join(root,'node.json'),metadata);
 return {status:created?'configured':'already-configured',participantCount:parsed.agents.length,liveVerified:false,
  next:'Verify Desktop login/chats and start the container transport; no agent was started by provisioning'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length>3)throw new Error('Usage: node provision_node.mjs [DATA_ROOT] < private-payload.json');
  let raw='',bytes=0;for await(const chunk of process.stdin){bytes+=Buffer.byteLength(chunk);if(bytes>262144)throw new Error('Provisioning input too large');raw+=chunk;}
  let payload;try{payload=JSON.parse(raw);}catch{throw new Error('Provisioning input must be valid JSON');}
  const result=await provisionNode({root:process.argv[2]||'/data',config:payload?.config,credentials:payload?.credentials});
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch(error){process.stderr.write((error.code?'Provisioning filesystem operation failed; existing files were not overwritten':error.message)+'\n');process.exitCode=1;}
}
