import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExpertConfigs} from './expert_config.mjs';

test('legacy environment cannot silently select someone else\'s bot or project',()=>{
 const base={TELEGRAM_BOT_TOKEN:'synthetic-test-value',TELEGRAM_CHAT_ID:'-1001234567890'};
 assert.throws(()=>parseExpertConfigs({env:base}),/invalid config/);
 assert.throws(()=>parseExpertConfigs({env:{...base,TELEGRAM_BOT_USERNAME:'local_peer_bot'}}),/invalid config/);
 const [config]=parseExpertConfigs({env:{...base,TELEGRAM_BOT_USERNAME:'local_peer_bot',PROJECT_CWD:'/workspace/local-project'}});
 assert.equal(config.username,'local_peer_bot');assert.equal(config.cwd,'/workspace/local-project');
});
