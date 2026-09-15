import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {atomicJson} from './atomic_json.mjs';
import {DesktopMcpClient} from './desktop_mcp_client.mjs';
import {AppServerClient} from './app_server_client.mjs';
import {discoverDesktopServer} from './desktop_server_path.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function promptFor(input) {
  return input.map(item=>{
    if(item.type==='text')return item.text;
    if(item.path && ['localImage','image','file'].includes(item.type))
      return `Telegram attachment available inside this container: ${item.path}. Read it with your tools when relevant; its contents are not in this text.`;
    throw new Error('Unsupported Desktop input; refusing to silently discard it');
  }).join('\n');
}
export class DesktopCodexClient extends EventEmitter {
  supportsDurableReplay=true;
  supportsSteer=true;
  constructor({root,clientFactory,pollMs=1500,serverOptions={}}={}) {
    super();this.root=root;this.pollMs=pollMs;this.contexts=new Map();this.nativeRead=!clientFactory;
    this.clientFactory=clientFactory || (async threadId=>new DesktopMcpClient({targetThreadId:threadId,
      sourceThreadId:process.env.CODEX_THREAD_ID,
      serverPath:await discoverDesktopServer(serverOptions)}));
  }
  async start() {await mkdir(this.root,{recursive:true});}
  async startOrResumeThread(expertId,{threadId}) {
    if(!threadId)throw new Error('Desktop migration requires the existing thread ID');
    await this.start();
    const mcp=await this.clientFactory(threadId);await mcp.start();
    const ctx={threadId,mcp};this.contexts.set(expertId,ctx);
    if(this.nativeRead){ctx.reader=new AppServerClient();await ctx.reader.start();}
    await this.snapshot(ctx);
    if(!this.timer)this.timer=setInterval(()=>this.tick().catch(()=>this.emit('warning','Desktop read unavailable; pending turn retained')),this.pollMs);
    return {id:threadId};
  }
  getThreadId(id){return this.contexts.get(id)?.threadId;}
  getActiveTurnId(id){return this.contexts.get(id)?.record?.activeId;}
  async snapshot(ctx) {
    if(ctx.reader){
      // Read only: Desktop retains the sole writer. Never resume this thread here.
      const {thread}=await ctx.reader.request('thread/read',{threadId:ctx.threadId,includeTurns:true});
      if(thread.id!==ctx.threadId)throw new Error('Native read target mismatch');
      return {thread:{id:thread.id,status:{type:thread.turns.some(t=>t.status==='inProgress')?'running':'idle'}},turns:thread.turns};
    }
    const result=await ctx.mcp.readThread({turnLimit:10,maxOutputCharsPerItem:20000});
    const data=JSON.parse(result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
    if(data.thread?.id!==ctx.threadId || !Array.isArray(data.turns))throw new Error('Desktop snapshot target mismatch');
    return data;
  }
  async startTurn(expertId,input) {
    const ctx=this.contexts.get(expertId);
    if(!ctx || ctx.record)throw new Error('Desktop turn is not ready');
    const prompt=promptFor(input);
    if(!prompt.trim()||prompt.length>19000)throw new Error('Desktop prompt exceeds the verifiable read window');
    const id=hash([expertId,ctx.threadId,input]),file=path.join(this.root,`${id}.json`);
    let record;
    try{record=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    let fresh=false;
    if(record) {
      if(record.prompt!==prompt||record.threadId!==ctx.threadId)throw new Error('Desktop replay identity mismatch');
    } else {
      const before=await this.snapshot(ctx);
      if(before.thread.status?.type!=='idle')throw Object.assign(new Error('Desktop task is busy outside the bridge'),
        {code:'DESKTOP_BUSY_BEFORE_SEND'});
      record={threadId:ctx.threadId,prompt,activeId:`desktop-${id}`,previousTurnIds:before.turns.map(x=>x.id),
        status:'sending',commentaryIds:[],steers:{}};
      await atomicJson(file,record);fresh=true;
    }
    ctx.record=record;ctx.file=file;
    const turn={id:record.activeId,expertId,status:'inProgress'};
    this.emit('turnStarted',turn);
    if(fresh) {
      try{await ctx.mcp.sendMessage(prompt);record.status='waiting';await atomicJson(file,record);}
      catch{this.emit('warning','Desktop send outcome uncertain; reconciling without repeating');}
    }
    return turn;
  }
  async steerTurn(expertId,input) {
    const ctx=this.contexts.get(expertId);
    if(!ctx?.record)throw new Error('No Desktop turn to steer');
    const prompt=promptFor(input),id=hash(prompt),record=ctx.record;
    if(record.steers[id])return {id:record.activeId};
    record.steers[id]='sending';await atomicJson(ctx.file,record);
    try{await ctx.mcp.sendMessage(prompt);record.steers[id]='sent';await atomicJson(ctx.file,record);}
    catch{this.emit('warning','Desktop steering outcome uncertain; not repeating');}
    return {id:record.activeId};
  }
  async tick() {
    if(this.polling)return;this.polling=true;
    try {for(const [expertId,ctx]of this.contexts) {
      const r=ctx.record;if(!r)continue;
      if(r.status!=='completed') {
        const data=await this.snapshot(ctx);
        const turn=data.turns.find(t=>!r.previousTurnIds.includes(t.id)&&t.items?.some(i=>
          (i.type==='userMessage'&&i.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')===r.prompt)||
          (i.type==='functionCallOutput'&&i.name==='send_message_to_thread'&&
            i.output===`<codex_delegation>\n  <source_thread_id>${ctx.threadId}</source_thread_id>\n  <input>${r.prompt}</input>\n</codex_delegation>`)));
        if(!turn)continue;
        for(const item of turn.items||[])if(item.type==='agentMessage'&&item.phase==='commentary'&&item.id&&!r.commentaryIds.includes(item.id)) {
          r.commentaryIds.push(item.id);await atomicJson(ctx.file,r);
          this.emit('commentary',{expertId,turnId:r.activeId,text:item.text});
        }
        if(data.thread.status?.type!=='idle'||!['completed','failed','interrupted'].includes(turn.status))continue;
        const items=turn.items.filter(i=>i.type==='agentMessage'&&i.phase!=='commentary');
        r.finalAnswer=items.some(i=>i.truncated||i.text?.length>=20000)
          ? 'Desktop returned a truncated answer. Read the original task; no partial answer was published.'
          : items.map(i=>i.text||'').join('\n\n');
        if(turn.error)r.finalAnswer=`Desktop task failed: ${turn.error.message||'unknown error'}`;
        r.status='completed';await atomicJson(ctx.file,r);
      }
      ctx.record=undefined;
      this.emit('turnCompleted',{expertId,id:r.activeId,status:'completed',finalAnswer:r.finalAnswer||''});
    }}finally{this.polling=false;}
  }
  close(){clearInterval(this.timer);this.timer=undefined;for(const c of this.contexts.values()){c.mcp.close();c.reader?.close();}}
}
