import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseNodeConfig} from './node_config.mjs';

export async function inspectNodeConfiguration({file,env=process.env}){
 let raw;
 try {raw=await readFile(file,'utf8');}
 catch {return {status:'invalid',liveVerified:false,error:'Cannot read node configuration file'};}
 let input;
 try {input=JSON.parse(raw);}
 catch {return {status:'invalid',liveVerified:false,error:'Node configuration must be valid JSON'};}
 try {
  const config=parseNodeConfig(input,{env,requireCredentials:false});
  return {status:config.missingCredentials.length?'needs-credentials':'configuration-valid',liveVerified:false,
   participantCount:config.agents.length,missingCredentials:config.missingCredentials,
   checksRemaining:['Desktop login and session availability','Installed adapter support for all configured participants',
    'Exclusive Telegram update consumer','Bot-to-bot group delivery','Live read/post/silence and restart checks']};
 }catch(error){return {status:'invalid',liveVerified:false,error:error.message};}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3){
  process.stderr.write('Usage: node node_preflight.mjs PATH_TO_NODE_JSON\n');process.exitCode=2;
 }else{
  const result=await inspectNodeConfiguration({file:process.argv[2]});
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.status==='invalid'?2:result.status==='needs-credentials'?3:0;
 }
}
