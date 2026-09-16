import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('Pro corrections survive restart and a frozen handoff never absorbs later messages on replay',async t=>{
 const {ProAttention}=await import('./pro_attention.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'pro-attention-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 let box=new ProAttention({root,chain:'a'.repeat(64)});
 await box.add('First question');await box.add('First question');
 const first=await box.freeze('b'.repeat(64),'Tool result');
 assert.equal(first.count,1);assert.match(first.prompt,/First question/);
 box=new ProAttention({root,chain:'a'.repeat(64)});
 await box.add('Second question');
 assert.deepEqual(await box.freeze('b'.repeat(64),'Tool result'),first);
 const next=await box.freeze('c'.repeat(64),'Next result');
 assert.equal(next.count,1);assert.match(next.prompt,/Second question/);
 assert.doesNotMatch(next.prompt,/First question/);
 assert.equal((await box.freeze('d'.repeat(64),'Another result')).count,0);
});

test('mailboxes isolate chains and reject oversized corrections without consuming anything',async t=>{
 const {ProAttention}=await import('./pro_attention.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'pro-attention-isolation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const a=new ProAttention({root,chain:'a'.repeat(64)});
 const b=new ProAttention({root,chain:'b'.repeat(64)});
 await a.add('Private to this chain');
 assert.equal((await b.freeze('c'.repeat(64),'Result')).count,0);
 await assert.rejects(a.add('x'.repeat(19001)),/length/);
 assert.equal((await a.freeze('d'.repeat(64),'Result')).count,1);
});
