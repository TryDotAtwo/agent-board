const session=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const reservedEnv=new Set(['HOME','PATH','SHELL','USER','LOGNAME','DISPLAY','BROWSER','TMPDIR','LANG',
 'EXPERTS_CONFIG','BRIDGE_DATA_DIR','MOLAB_ENABLED','KAGGLE_API_TOKEN','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']);
function fields(value,allowed,label){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be an object`);
 if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error(`${label} has unknown fields`);
}
function valid(value,pattern,label){
 if(typeof value!=='string'||!pattern.test(value))throw new Error(`Invalid ${label}`);
 return value;
}

// Public metadata contains only credential references, never their values.
export function parseNodeConfig(input,{env=process.env,requireCredentials=true}={}){
 fields(input,['version','board_chat_id','desktop','agents'],'Node configuration');
 if(input.version!==1)throw new Error('Unsupported node configuration version');
 if(!Number.isSafeInteger(input.board_chat_id)||input.board_chat_id>=0)throw new Error('board_chat_id must be a negative group ID');
 fields(input.desktop,['executor_thread_id'],'Desktop configuration');
 const executorThreadId=valid(input.desktop.executor_thread_id,session,'Desktop executor session ID');
 if(!Array.isArray(input.agents)||!input.agents.length)throw new Error('Configure at least one participant');
 const seen={id:new Set(),username:new Set(),token_env:new Set(),thread_id:new Set()};
 const missingCredentials=[];
 const credentialValues=new Set();
 const agents=input.agents.map(item=>{
  fields(item,['id','username','token_env','backend','thread_id'],'Participant');
  const id=valid(item.id,/^[a-z][a-z0-9_-]{0,63}$/,'participant ID');
  const username=valid(item.username,/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/,'bot username');
  const tokenEnv=valid(item.token_env,/^[A-Z][A-Z0-9_]{0,127}$/,'token environment variable');
  if(reservedEnv.has(tokenEnv)||/^(NODE_|CODEX_|LD_|DYLD_|PYTHON|PRO_|BOARD_|XDG_|DBUS_)/.test(tokenEnv))throw new Error('Credential variable name is reserved for runtime configuration');
  const threadId=valid(item.thread_id,session,'participant session ID');
  if(!['codex-desktop','chatgpt-desktop'].includes(item.backend))throw new Error('Unsupported participant backend');
  for(const [field,value]of Object.entries({id,username:username.toLowerCase(),token_env:tokenEnv,thread_id:threadId.toLowerCase()})){
   if(seen[field].has(value))throw new Error(`Duplicate participant ${field}`);
   seen[field].add(value);
  }
  if(typeof env[tokenEnv]!=='string'||!env[tokenEnv].trim())missingCredentials.push(tokenEnv);
  else {
   const credential=env[tokenEnv].trim();
   if(credentialValues.has(credential))throw new Error('Multiple participants reference the same bot credential');
   credentialValues.add(credential);
  }
  return {id,username,tokenEnv,backend:item.backend,threadId};
 });
 if(requireCredentials&&missingCredentials.length)throw new Error(`Missing credential variables: ${missingCredentials.join(', ')}`);
 return {version:1,boardChatId:input.board_chat_id,executorThreadId,agents,missingCredentials};
}
