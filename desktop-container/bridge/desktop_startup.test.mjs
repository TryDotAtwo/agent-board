import test from 'node:test';import assert from 'node:assert/strict';
test('startup refuses another selected task, an occupied draft or an already sent boot',async()=>{
 const {startupDecision}=await import('./desktop_startup_policy.mjs').catch(()=>({}));
 assert.equal(typeof startupDecision,'function');
 const base={target:'a',selected:'a',draft:'',busy:false,attempted:false};
 assert.equal(startupDecision(base),'send');
 assert.equal(startupDecision({...base,selected:'b'}),'wait');
 assert.equal(startupDecision({...base,draft:'user draft'}),'blocked-draft');
 assert.equal(startupDecision({...base,attempted:true}),'reconcile');
 assert.equal(startupDecision({...base,busy:true}),'wait');
});
