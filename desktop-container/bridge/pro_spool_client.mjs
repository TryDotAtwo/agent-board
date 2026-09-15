import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';

const ATTACHMENT_ERROR = 'Frontier Pro: этот шлюз пока передаёт только текст. Вложения не отправлены в ChatGPT; пришлите нужный фрагмент текстом или обратитесь к Codex-эксперту.';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validThread = id => typeof id === 'string' && id.trim() && id.length <= 256;

// A transport adapter, not another agent. Stable input identity lets scheduler
// restart replay attach to an existing job instead of duplicating a Chat send.
export class ProSpoolClient extends EventEmitter {
  supportsDurableReplay = true;
  supportsSteer = false;
  supportsAttachments = false;
  constructor({root, pollMs = 1000, boardProtocol, now=Date.now}) {
    super();
    if (!root || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('invalid Pro spool options');
    this.root = path.resolve(root); this.pollMs = pollMs; this.contexts = new Map(); this.closed = false;
    this.polling = false;
    this.boardProtocol = boardProtocol;
    this.now=now;
  }
  async startOrResumeThread(expertId, {chatThreadId, threadId} = {}) {
    if (!validThread(chatThreadId) || (threadId && threadId !== chatThreadId)) throw new Error('Pro stored thread must match fixed chat_thread_id');
    if (this.contexts.size && !this.contexts.has(expertId)) throw new Error('one Pro spool supports one expert');
    await Promise.all(['requests','results'].map(x=>mkdir(path.join(this.root,x), {recursive:true})));
    this.contexts.set(expertId,{threadId:chatThreadId});
    this.closed = false;
    this.#schedule();
    return {id:chatThreadId};
  }
  getThreadId(expertId) { return this.contexts.get(expertId)?.threadId; }
  getActiveTurnId(expertId) { return this.contexts.get(expertId)?.activeTurnId; }
  async startTurn(expertId, input) {
    const ctx = this.contexts.get(expertId);
    if (!ctx || this.closed) throw new Error('Pro client is not ready');
    if (ctx.activeTurnId) throw new Error('Pro turn already active');
    if (!Array.isArray(input) || !input.length) throw new Error('Pro input is empty');
    const rawPrompt = input.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    const prompt = this.boardProtocol ? `${this.boardProtocol.instructions()}\n\n${rawPrompt}` : rawPrompt;
    const id = hash([expertId,ctx.threadId,input]);
    const unsupported = input.some(x=>x.type!=='text' || typeof x.text!=='string')
      || prompt.includes('Вложения доступны только на чтение:');
    let localError = unsupported ? ATTACHMENT_ERROR : undefined;
    if (!localError && (!prompt.trim() || prompt.length>19000 || Buffer.byteLength(prompt,'utf8')>120000)) {
      localError = 'Frontier Pro: сообщение пустое или превышает лимит шлюза 19 000 символов. Сократите его.';
    }
    if (!localError) {
      const file = path.join(this.root,'requests',`${id}.json`);
      const request = {id,threadId:ctx.threadId,prompt,createdAt:new Date().toISOString()};
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Pro request is not a regular file');
        const existing = JSON.parse(await readFile(file,'utf8'));
        const catalogUpgrade=this.boardProtocol&&typeof existing.prompt==='string'&&existing.prompt.endsWith('\n\n'+rawPrompt);
        if (existing.id!==id || existing.threadId!==ctx.threadId || (existing.prompt!==prompt&&!catalogUpgrade)) throw new Error('Pro request identity conflict');
      } catch (error) {
        if (error.code!=='ENOENT') throw error;
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp,JSON.stringify(request),{flag:'wx'});
        await rename(temp,file);
      }
    }
    Object.assign(ctx,{id,activeTurnId:`pro-${id}`,localError});
    const turn = {id:ctx.activeTurnId,expertId,status:'inProgress'};
    this.emit('turnStarted',turn);
    return turn;
  }
  async steerTurn() { throw new Error('Chat backend does not support steering; queue followups'); }
  async #continueBoard(expertId,ctx,prompt) {
    const id=hash([expertId,ctx.threadId,ctx.id,prompt]);
    const file=path.join(this.root,'requests',`${id}.json`);
    // Deterministic identity permits restart replay of an entire command chain.
    try {
      const existing=JSON.parse(await readFile(file,'utf8'));
      if(existing.id!==id||existing.threadId!==ctx.threadId||existing.prompt!==prompt) throw new Error('Pro continuation identity conflict');
    } catch(error) {
      if(error.code!=='ENOENT') throw error;
      const temp=`${file}.${randomUUID()}.tmp`;
      await writeFile(temp,JSON.stringify({id,threadId:ctx.threadId,prompt,createdAt:new Date().toISOString()}),{flag:'wx'});
      await rename(temp,file);
    }
    ctx.id=id;
  }
  async tick() {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      for (const [expertId,ctx] of this.contexts) {
        if (!ctx.activeTurnId) continue;
        let answer = ctx.localError;
        if (!answer) {
          const file = path.join(this.root,'results',`${ctx.id}.json`);
          let result;
          try {
            const info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size>16000000) throw new Error('invalid Pro result file');
            result = JSON.parse(await readFile(file,'utf8'));
            if (result.id!==ctx.id || result.threadId!==ctx.threadId) throw new Error('Pro result target mismatch');
            if (result.status==='blocked') {
              if (!ctx.blockedWarned) { ctx.blockedWarned=true; this.emit('warning','Pro send outcome requires history reconciliation; no automatic resend'); }
              continue;
            }
            if (result.status!=='completed') continue;
            if (result.silent===true) {
              if (result.answer!==undefined) throw new Error('invalid Pro silent result');
              answer='';
            } else {
              if (typeof result.answer!=='string' || !result.answer.trim()) throw new Error('invalid Pro answer');
              answer=result.answer;
              if(this.boardProtocol) {
                const command=await this.boardProtocol.handle({id:ctx.id,answer});
                if(command?.prompt) {
                  if(command.notBefore!==undefined) {
                    if(!Number.isSafeInteger(command.notBefore)||command.notBefore<0)throw new Error('invalid wake deadline');
                    if(this.now()<command.notBefore)continue;
                  }
                  await this.#continueBoard(expertId,ctx,command.prompt);continue;
                }
                if(command?.silent) answer='';
              }
            }
          } catch (error) {
            if (error.code!=='ENOENT' && !ctx.readWarned) { ctx.readWarned=true; this.emit('warning', 'Pro result is unavailable or invalid; retaining pending request'); }
            continue;
          }
        }
        const turnId = ctx.activeTurnId;
        delete ctx.activeTurnId; delete ctx.id; delete ctx.localError;
        delete ctx.blockedWarned; delete ctx.readWarned;
        this.emit('turnCompleted',{id:turnId,expertId,status:'completed',finalAnswer:answer});
      }
    } finally { this.polling=false; }
  }
  #schedule() {
    if (this.timer || this.closed) return;
    this.timer=setTimeout(async()=>{
      this.timer=undefined;
      try { await this.tick(); } finally { this.#schedule(); }
    },this.pollMs);
    this.timer.unref?.();
  }
  close() { this.closed=true; clearTimeout(this.timer); this.timer=undefined; }
}
