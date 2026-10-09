import {mkdir, open, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {botToken, redact} from './credentials.mjs';
import {TelegramBotClient} from '../desktop-container/bridge/telegram_output.mjs';

process.umask(0o077);
let token;
try {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) throw new Error('Configuration exceeds 64 KiB');
  }
  const input = JSON.parse(text);
  if (!input || !/^[a-z][a-z0-9-]{0,47}$/.test(input.id || '') ||
      !Number.isSafeInteger(input.boardChatId) || input.boardChatId >= 0 ||
      typeof input.model !== 'string' || !/^[a-z0-9.-]+$/.test(input.model) ||
      typeof input.objective !== 'string' || !input.objective.trim() ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoningEffort)) {
    throw new Error('Required: safe lowercase id, negative boardChatId, model, reasoningEffort, and nonempty objective');
  }
  token = await botToken();
  const telegram = new TelegramBotClient({token, retryDelays: []});
  const me = await telegram.request('getMe', {});
  const webhook = await telegram.request('getWebhookInfo', {});
  if (webhook.url) throw new Error('Existing webhook detected; no configuration was written');
  const chat = await telegram.request('getChat', {chat_id: input.boardChatId});
  if (chat.id !== input.boardChatId) throw new Error('Unexpected Telegram group identity');
  await mkdir('/data', {recursive: true, mode: 0o700});
  const config = {
    version: 1,
    id: input.id,
    sessionId: randomUUID(),
    botUsername: me.username,
    botId: me.id,
    boardChatId: input.boardChatId,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    objective: input.objective,
  };
  const file = '/data/copilot-node.json';
  let previous;
  try { previous = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    if (JSON.stringify({...previous, sessionId: ''}) !== JSON.stringify({...config, sessionId: ''})) {
      throw new Error('Existing node differs; refusing to replace its conversation or objective');
    }
    console.log(JSON.stringify({status: 'already-configured', sessionId: previous.sessionId}));
  } else {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(config) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    console.log(JSON.stringify({status: 'configured', sessionId: config.sessionId, botUsername: me.username, liveVerified: false}));
  }
} catch (error) {
  console.error(redact(error.message, [token]));
  process.exitCode = 1;
}
