import {createHash} from 'node:crypto';
const keyFor=record=>createHash('sha256').update(JSON.stringify(record)).digest('hex');

// Durable transport ownership, not a collaboration scheduler. The active input
// is frozen before handoff; only adapters with durable input replay may recover.
export class BoardTurnTransport {
 constructor({state,saveState,client,expertId,prepareInput,onStarted}){
  Object.assign(this,{state,saveState,client,expertId,prepareInput,onStarted});
  state.boardTransport ||= {active:null};this.chain=Promise.resolve();
 }
 #serial(fn){const result=this.chain.then(fn);this.chain=result.catch(()=>{});return result;}
 accept(record){return this.#serial(()=>this.#accept(record));}
 restore(){return this.#serial(()=>this.#restore());}
 reconcile(record){
  if(this.client.supportsDurableReplay!==true)return Promise.resolve('blocked');
  return this.accept(record);
 }
 complete(turnId,deliver){return this.#serial(async()=>{
  const data=this.state.boardTransport;
  if(!data.active||data.active.turnId!==turnId)return 'ignored';
  await deliver(); // Persist final delivery before releasing transport ownership.
  data.active=null;await this.saveState(this.state);return 'completed';
 });}
 async #restore(){
  const active=this.state.boardTransport.active;if(!active)return 'idle';
  if(this.client.supportsDurableReplay!==true)throw new Error('Board adapter cannot safely restore durable input');
  const running=this.client.getActiveTurnId(this.expertId);
  if(running&&running!==active.turnId)throw new Error('Board active turn identity conflicts with client');
  if((!running||!active.accepted)&&await this.#startActive()==='waiting')return 'waiting';
  if(active.pending)await this.#steerPending();
  return 'restored';
 }
 async #startActive(){
  const data=this.state.boardTransport,active=data.active;
  const running=this.client.getActiveTurnId(this.expertId);
  if(running&&running!==active.turnId)throw new Error('Board active turn identity conflicts with client');
  let turn;
  try{turn=running?{id:running}:await this.client.startTurn(this.expertId,active.input);}
  catch(error){
   // Only an explicit pre-send refusal is retryable. Uncertain sends retain
   // the adapter's durable replay path; never classify them by error text.
   if(error.code==='DESKTOP_BUSY_BEFORE_SEND')return 'waiting';
   throw error;
  }
  active.turnId=turn.id;
  await this.onStarted(active.record,turn.id);
  if(!active.accepted){data.receipt={key:active.key,result:'started'};active.accepted=true;}
  await this.saveState(this.state);
  return 'started';
 }
 async #steerPending(){
  const data=this.state.boardTransport,pending=data.active.pending;
  await this.client.steerTurn(this.expertId,pending.input);
  data.receipt={key:pending.key,result:'steered'};delete data.active.pending;
  await this.saveState(this.state);return 'steered';
 }
 async #accept(record){
  const data=this.state.boardTransport,key=keyFor(record);
  if(data.receipt?.key===key){await this.saveState(this.state);return data.receipt.result;}
  if(data.active){
   if((!data.active.accepted||!this.client.getActiveTurnId(this.expertId))&&await this.#restore()==='waiting')return 'waiting';
   if(data.receipt?.key===key){await this.saveState(this.state);return data.receipt.result;}
   if(this.client.supportsSteer===false)return 'waiting';
   if(data.active.pending){
    if(data.active.pending.key!==key)throw new Error('Previous board handoff needs reconciliation');
   }else{
    data.active.pending={key,input:await this.prepareInput(record)};
    await this.saveState(this.state);
   }
   return this.#steerPending();
  }
  data.active={key,record,input:await this.prepareInput(record)};
  await this.saveState(this.state); // Nothing external has happened yet.
  return this.#startActive();
 }
}
