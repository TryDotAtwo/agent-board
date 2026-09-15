import test from 'node:test';
import assert from 'node:assert/strict';

const config=()=>({version:1,board_chat_id:-1001234567890,
 desktop:{executor_thread_id:'11111111-1111-4111-8111-111111111111'},
 agents:[{id:'alice',username:'alice_board_bot',token_env:'ALICE_BOT_TOKEN',
  backend:'codex-desktop',thread_id:'11111111-1111-4111-8111-111111111111'}]});
async function parse(input,env={ALICE_BOT_TOKEN:'private-test-value'}) {
 const mod=await import('./node_config.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
 assert.equal(typeof mod.parseNodeConfig,'function','portable node configuration parser is required');
 return mod.parseNodeConfig(input,{env});
}
test('one independently named participant needs no Astra/Pro pair',async()=>{
 const result=await parse(config());
 assert.equal(result.agents.length,1);
 assert.equal(result.agents[0].id,'alice');
 assert.equal(result.agents[0].threadId,'11111111-1111-4111-8111-111111111111');
 assert.equal(result.boardChatId,-1001234567890);
 assert.equal(result.agents[0].tokenEnv,'ALICE_BOT_TOKEN');
 assert.ok(!JSON.stringify(result).includes('private-test-value'),'validated public metadata must not contain credentials');
});
test('accepts independent permanent chats and does not invent a model selection',async()=>{
 const input=config();input.agents.push({id:'bob',username:'bob_board_bot',token_env:'BOB_BOT_TOKEN',
  backend:'chatgpt-desktop',thread_id:'22222222-2222-4222-8222-222222222222'});
 const result=await parse(input,{ALICE_BOT_TOKEN:'one',BOB_BOT_TOKEN:'two'});
 assert.equal(result.agents[1].backend,'chatgpt-desktop');
 assert.equal(result.agents[1].model,undefined);
 assert.equal(result.agents[1].threadId,'22222222-2222-4222-8222-222222222222');
});
test('missing credentials report the variable name but never echo provided secret values',async()=>{
 const input=config();input.agents[0].token_env='MISSING_BOT_TOKEN';
 await assert.rejects(parse(input),/MISSING_BOT_TOKEN/);
});
test('rejects raw inline secrets and unknown instruction fields without echoing them',async()=>{
 for(const field of ['token','developer_instructions','system_prompt']){
  const input=config();input.agents[0][field]='do-not-echo-this';
  await assert.rejects(parse(input),e=>!e.message.includes('do-not-echo-this')&&/unknown/i.test(e.message));
 }
});
test('rejects duplicated identities, usernames, token sources and permanent chats',async()=>{
 for(const field of ['id','username','token_env','thread_id']){
  const input=config();const second={id:'bob',username:'bob_board_bot',token_env:'BOB_BOT_TOKEN',backend:'codex-desktop',thread_id:'22222222-2222-4222-8222-222222222222'};
  second[field]=input.agents[0][field];input.agents.push(second);
  await assert.rejects(parse(input,{ALICE_BOT_TOKEN:'one',BOB_BOT_TOKEN:'two'}),/duplicate/i);
 }
});
test('rejects malformed destinations, unsafe identity paths and missing session IDs',async()=>{
 for(const mutate of [x=>x.board_chat_id=123,x=>x.board_chat_id='-100123',x=>x.agents[0].id='../escape',
  x=>x.agents[0].thread_id='',x=>x.desktop.executor_thread_id='not-a-session',x=>x.version=2]){
  const input=config();mutate(input);await assert.rejects(parse(input));
 }
});
test('preflight can inspect configuration before credentials are entered',async()=>{
 const mod=await import('./node_config.mjs');
 const result=mod.parseNodeConfig(config(),{env:{},requireCredentials:false});
 assert.deepEqual(result.missingCredentials,['ALICE_BOT_TOKEN']);
});
test('different credential variables cannot secretly start two consumers for one bot',async()=>{
 const input=config();input.agents.push({id:'bob',username:'bob_board_bot',token_env:'BOB_BOT_TOKEN',
  backend:'codex-desktop',thread_id:'22222222-2222-4222-8222-222222222222'});
 await assert.rejects(parse(input,{ALICE_BOT_TOKEN:'same-private-value',BOB_BOT_TOKEN:'same-private-value'}),
  e=>/same bot credential/i.test(e.message)&&!e.message.includes('same-private-value'));
});
test('bot credentials cannot overwrite process or provider control variables',async()=>{
 for(const name of ['HOME','PATH','NODE_OPTIONS','CODEX_HOME','LD_PRELOAD','PRO_GATEWAY_ROOT','BOARD_NODE_CONFIG','MOLAB_ENABLED','KAGGLE_API_TOKEN']){
  const input=config();input.agents[0].token_env=name;
  await assert.rejects(parse(input,{[name]:'nonempty-test-token'}),/reserved/i);
 }
});
