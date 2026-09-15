import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {TelegramBoardStore} from './telegram_board_store.mjs';
import {TelegramBoardService} from './telegram_board_service.mjs';
import {TelegramBoardInbox} from './telegram_board_inbox.mjs';
import {TelegramBoardAttachments} from './telegram_board_attachments.mjs';
import {TelegramBotClient} from './telegram_output.mjs';
import {telegramRecord} from './bridge_core.mjs';

export async function createTelegramBoardHub({configs,dataRoot,fetchImpl,log=async()=>{}}) {
  const chats=new Set(configs.filter(c=>c.board).map(c=>c.chatId));
  if(!chats.size) return undefined;
  const root=path.join(dataRoot,'telegram-board');
  const store=new TelegramBoardStore({file:path.join(root,'board.sqlite')});
  const attachments=new TelegramBoardAttachments({store,root:path.join(root,'attachments')});
  const archive=(record,options)=>chats.has(record.chat_id)?store.append(record,options):undefined;
  const attachmentRoots=[attachments.root,...configs.filter(c=>chats.has(c.chatId)).map(c=>path.join(dataRoot,'experts',c.id,'attachments'))];
  // Import only the transport's existing local records, not fabricated Telegram history.
  try {
    for(const cfg of configs.filter(c=>chats.has(c.chatId))) {
      const key=`import:${cfg.id}`;
      if(store.getState(key)?.done) continue;
      const file=path.join(dataRoot,'experts',cfg.id,'chat','messages.jsonl');
      const stream=createReadStream(file,{encoding:'utf8'});
      const lines=createInterface({input:stream,crlfDelay:Infinity});
      let count=0;
      try {
        for await(const line of lines) {if(line.trim()) {archive(JSON.parse(line));count++;}}
      } catch(error) {if(error.code!=='ENOENT') throw new Error(`board journal import failed for ${cfg.id}: ${error.message}`);}
      finally {lines.close();stream.destroy();}
      store.setState(key,{done:true,count});
    }
  } catch(error) {store.close();throw error;}
  const clients=new Map(),postClients=new Map();
  function telegram(config) {
    if(clients.has(config.id)) return clients.get(config.id);
    const client=new TelegramBotClient({token:config.token,fetchImpl,
      onObserverError:error=>log(`board outbound archive error: ${error.message}`),
      onMessage:async(message,meta)=>{
        if(!message?.message_id||!chats.has(message.chat?.id)) return;
        const record=telegramRecord(message);
        archive(record,{kind:meta.kind});
        if(record.attachments.length) archive(await attachments.download(record,client),{kind:meta.kind});
      }});
    clients.set(config.id,client);return client;
  }
  const service=new TelegramBoardService({store,configs,attachmentRoots,
    send:async(id,body)=>{
      if(!postClients.has(id)) {
        const cfg=configs.find(c=>c.id===id&&c.board);
        postClients.set(id,new TelegramBotClient({token:cfg.token,fetchImpl,retryDelays:[]}));
      }
      return postClients.get(id).sendText(body);
    }});
  return {store,service,archive,attachments,attachmentRoots,telegram,
    includes:chatId=>chats.has(chatId),
    inbox:(config,client,deliver,reconcile)=>new TelegramBoardInbox({store,config,client,deliver,reconcile})};
}
