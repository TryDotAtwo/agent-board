import {createRequire} from 'node:module';import {readFile,stat} from 'node:fs/promises';
import {desktopConfig} from './desktop_config.mjs';import {startupDecision} from './desktop_startup_policy.mjs';
import {atomicJson} from './atomic_json.mjs';
import {AppServerClient} from './app_server_client.mjs';
const {chromium}=createRequire('/usr/local/lib/node_modules/@playwright/mcp/package.json')('playwright');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const root='/data',file=`${root}/desktop-startup.json`;
const startTicks=(await readFile('/proc/1/stat','utf8')).split(') ')[1].split(' ')[19];
const boot=`${(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()}:${startTicks}`;
let state;try{state=JSON.parse(await readFile(file,'utf8'));}catch{}
if(state?.boot!==boot)state={boot,attempted:false,status:'starting'};
const save=async status=>{state.status=status;state.updatedAt=new Date().toISOString();await atomicJson(file,state);};
let browser;const observer=new AppServerClient();
try{
 const config=await desktopConfig();const deadline=Date.now()+180000;
 await observer.start();
 while(Date.now()<deadline){
  try{
   const health=JSON.parse(await readFile(`${root}/relay-health.json`,'utf8'));
   if(health.status==='running'&&Date.now()-Date.parse(health.updatedAt)<10000){
    process.kill(health.pid,0);await save('relays-started');break;
   }
  }catch{}
  if(state.attempted){await save('awaiting-relays');await pause(2000);continue;}
  try{
   if(!browser?.isConnected())browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:3000});
   const page=browser.contexts()[0].pages().find(p=>p.url()==='app://-/index.html');
   if(!page){await pause(2000);continue;}
   // These are visible DOM attributes of the installed pinned Desktop UI, not hidden application state.
   const row=page.locator(`[data-app-action-sidebar-thread-id="local:${config.astraThreadId}"]`);
   if(await row.count()!==1){await save('waiting-for-configured-task');await pause(2000);continue;}
   if(await row.getAttribute('data-app-action-sidebar-thread-selected')!=='true'){
    await row.click({timeout:2000});await pause(1000);continue;
   }
   const editor=page.getByRole('textbox',{name:'Do anything',exact:true});
   if(await editor.count()!==1){await pause(1000);continue;}
   const snapshot=await observer.request('thread/read',{threadId:config.astraThreadId,includeTurns:true});
   // Sidebar "active" denotes the active UI task, not a running model turn.
   const busy=snapshot.thread.turns.some(turn=>turn.status==='inProgress');
   const decision=startupDecision({target:config.astraThreadId,
    selected:(await row.getAttribute('data-app-action-sidebar-thread-selected'))==='true'?config.astraThreadId:null,
    busy,draft:await editor.innerText(),attempted:state.attempted});
   if(decision==='blocked-draft'){await save(decision);break;}
   if(decision!=='send'){await pause(1000);continue;}
   const prompt='Container transport startup. The approved local lifecycle hook starts the Telegram relays automatically. For this maintenance turn only: do not run tools, do not send Telegram messages, return an empty final answer. Future board messages remain normal collaborative requests.';
   await editor.fill(prompt);
   if(await row.getAttribute('data-app-action-sidebar-thread-selected')!=='true'){
    await save('selection-changed');break;
   }
   const send=page.getByRole('button',{name:'Send',exact:true});
   if(await send.count()!==1||!await send.isEnabled()){await save('send-unavailable');break;}
   // Persist before the external action. An ambiguous click is never repeated automatically.
   state.attempted=true;await save('sending-startup');await send.click({timeout:3000});
  }catch{await save(state.attempted?'send-outcome-uncertain':'waiting-for-desktop');}
  await pause(2000);
 }
 if(state.status!=='relays-started'&&!['blocked-draft','selection-changed','send-unavailable'].includes(state.status))await save('startup-needs-attention');
}catch{await save('configuration-or-desktop-unavailable');}
finally{observer.close();await browser?.close().catch(()=>{});}
