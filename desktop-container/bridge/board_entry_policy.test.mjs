import test from 'node:test';
import assert from 'node:assert/strict';

test('transport starts while native research runs without sending or waiting for idle', async () => {
  const {startBoardTransport} = await import('./board_entry_policy.mjs');
  const calls=[];
  const client={start:async()=>calls.push('connect'),
    readThread:async()=>{calls.push('read');return {content:[{type:'text',text:JSON.stringify({thread:{id:'research',status:{type:'running'}}})}]};},
    close:()=>calls.push('close'),sendMessage:()=>assert.fail('startup must not send')};
  await startBoardTransport({client,threadId:'research',loadBridge:async()=>calls.push('load')});
  assert.deepEqual(calls,['connect','read','close','load']);
});

test('failed or mismatched Desktop read prevents startup and closes the client',async()=>{
  const {startBoardTransport}=await import('./board_entry_policy.mjs');
  for(const mode of ['error','wrong-target']){
    let closed=false;
    const client={start:async()=>{},readThread:async()=>{
      if(mode==='error')throw new Error('unavailable');
      return {content:[{type:'text',text:JSON.stringify({thread:{id:'wrong',status:{type:'idle'}}})}]};
    },close:()=>{closed=true;}};
    await assert.rejects(startBoardTransport({client,threadId:'research',loadBridge:async()=>assert.fail('must not load')}));
    assert.equal(closed,true);
  }
});
