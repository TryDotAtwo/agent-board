import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {isAddressedMessage} from './bridge_core.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer=(value,name,min=0,max=Number.MAX_SAFE_INTEGER)=>{
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(`invalid ${name}`);
  return value;
};
function identity(r) {
  return [r.text||'',r.edit_date||0,r.message_thread_id||0,r.reply_to_message_id||0,
    (r.attachments||[]).map(a=>[a.kind,a.file_unique_id||a.file_id,a.file_name,a.mime_type,a.file_size])];
}

// One bridge process owns the SQLite connection; tools use the same service.
// The database is a transport journal, never a model-generated memory summary.
export class TelegramBoardStore {
  constructor({file}) {
    mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
    this.db=new DatabaseSync(file);
    this.db.function('board_addressed',{deterministic:true},(text,repliedTo,username)=>Number(isAddressedMessage(
      {text,reply_to_message:{from:{username:repliedTo}}},username)));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, chat INTEGER NOT NULL, message INTEGER NOT NULL,
        topic INTEGER NOT NULL, sender TEXT NOT NULL, kind TEXT NOT NULL,
        version TEXT NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(chat,message,version));
      CREATE INDEX IF NOT EXISTS events_chat_seq ON events(chat,seq);
      CREATE TABLE IF NOT EXISTS latest (chat INTEGER NOT NULL, message INTEGER NOT NULL,
        seq INTEGER NOT NULL, PRIMARY KEY(chat,message));
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS posts (expert TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,
        status TEXT NOT NULL,result TEXT,PRIMARY KEY(expert,key));`);
  }
  lastSeq() {return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n);}
  append(record,{kind='content'}={}) {
    this.db.exec('SAVEPOINT board_append');
    try {const event=this.#append(record,kind);this.db.exec('RELEASE board_append');return event;}
    catch(error) {this.db.exec('ROLLBACK TO board_append; RELEASE board_append');throw error;}
  }
  #append(record,kind) {
    integer(record.chat_id,'chat_id',-Number.MAX_SAFE_INTEGER);
    integer(record.message_id,'message_id',1);
    const version=hash(identity(record));
    const old=this.db.prepare('SELECT * FROM events WHERE chat=? AND message=? AND version=?')
      .get(record.chat_id,record.message_id,version);
    if(old) {
      // An outbound observer may enrich the same event after another bot sees it.
      const previous=JSON.parse(old.payload);
      const attachments=(record.attachments?.length?record.attachments:previous.attachments||[]).map(item=>{
        const cached=previous.attachments?.find(a=>(a.file_unique_id||a.file_id)===(item.file_unique_id||item.file_id));
        const merged={...cached,...item};
        if(cached?.local_path&&!item.local_path) {merged.local_path=cached.local_path;merged.sha256=cached.sha256;delete merged.error;}
        return merged;
      });
      const enriched={...previous,...record,attachments};
      const effectiveKind=kind==='status'||old.kind==='status'?'status':old.kind;
      this.db.prepare('UPDATE events SET kind=?,payload=? WHERE seq=?').run(effectiveKind,JSON.stringify(enriched),old.seq);
      return {...enriched,seq:Number(old.seq),kind:effectiveKind,duplicate:true};
    }
    const current=this.getMessage(record.chat_id,record.message_id);
    const stale=current && (current.edit_date||current.date||0)>(record.edit_date||record.date||0);
    if(stale) kind='stale';
    const result=this.db.prepare('INSERT INTO events(chat,message,topic,sender,kind,version,text,payload) VALUES(?,?,?,?,?,?,?,?)')
      .run(record.chat_id,record.message_id,record.message_thread_id||0,String(record.sender||'').toLowerCase(),kind,version,
        record.text||'',JSON.stringify(record));
    const seq=Number(result.lastInsertRowid);
    if(!stale) this.db.prepare('INSERT INTO latest(chat,message,seq) VALUES(?,?,?) ON CONFLICT(chat,message) DO UPDATE SET seq=excluded.seq')
      .run(record.chat_id,record.message_id,seq);
    return {...record,seq,kind,duplicate:false};
  }
  #decode(row) {return {...JSON.parse(row.payload),seq:Number(row.seq),kind:row.kind};}
  readUpdates({chatId,after=0,topicId,limit=50,maxChars=50000,excludeSender,includeStatus=false}={}) {
    integer(chatId,'chatId',-Number.MAX_SAFE_INTEGER); integer(after,'cursor'); integer(limit,'limit',1,200);
    integer(maxChars,'maxChars',1000,500000);
    const args=[chatId,after]; const where=['chat=?','seq>?'];
    if(!includeStatus) where.push("kind='content'");
    if(topicId!==undefined) {integer(topicId,'topicId');where.push('topic=?');args.push(topicId);}
    if(excludeSender) {where.push('sender<>?');args.push(String(excludeSender).toLowerCase());}
    const rows=this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args,limit+1);
    const messages=[]; let chars=0;
    for(const row of rows) {
      if(messages.length>=limit || (messages.length && chars+row.payload.length>maxChars)) break;
      messages.push(this.#decode(row)); chars+=row.payload.length;
    }
    return {messages,nextCursor:messages.at(-1)?.seq??Math.max(after,this.lastSeq()),
      hasMore:messages.length<rows.length,overBudget:chars>maxChars};
  }
  getMessage(chatId,messageId) {
    const row=this.db.prepare('SELECT e.* FROM latest l JOIN events e ON e.seq=l.seq WHERE l.chat=? AND l.message=?').get(chatId,messageId);
    return row?this.#decode(row):undefined;
  }
  readAddressed({chatId,username,after=0,through=this.lastSeq(),limit=8,maxChars=10000}) {
    integer(chatId,'chatId',-Number.MAX_SAFE_INTEGER);integer(after,'cursor');integer(through,'through cursor',after);
    integer(limit,'limit',1,200);integer(maxChars,'maxChars',1000,500000);
    if(typeof username!=='string'||!/^@?[a-z0-9_]+$/i.test(username))throw new Error('invalid bot username');
    username=username.replace(/^@/,'').toLowerCase();
    const from=`FROM events e JOIN latest current ON current.chat=e.chat AND current.message=e.message AND current.seq=e.seq
      LEFT JOIN latest parent_latest ON parent_latest.chat=e.chat AND parent_latest.message=CAST(json_extract(e.payload,'$.reply_to_message_id') AS INTEGER)
      LEFT JOIN events parent ON parent.seq=parent_latest.seq
      WHERE e.chat=? AND e.seq>? AND e.seq<=? AND e.kind='content' AND e.sender<>?
      AND board_addressed(e.text,COALESCE(json_extract(e.payload,'$.reply_to_sender'),parent.sender,''),?)=1`;
    const args=[chatId,after,through,username,username];
    const total=Number(this.db.prepare(`SELECT count(*) AS n ${from}`).get(...args).n);
    const rows=this.db.prepare(`SELECT e.* ${from} ORDER BY e.seq DESC LIMIT ?`).all(...args,limit);
    const selected=[];let chars=0;
    for(const row of rows){if(selected.length&&chars+row.payload.length>maxChars)break;selected.push(this.#decode(row));chars+=row.payload.length;}
    selected.reverse();
    return {messages:selected,total,throughCursor:through,hasMore:total>selected.length,
      nextBeforeCursor:selected.length?selected[0].seq-1:after,afterCursor:after};
  }
  readDiscussion({chatId,messageId,afterMessageId=0,limit=100}) {
    integer(chatId,'chatId',-Number.MAX_SAFE_INTEGER);integer(messageId,'messageId',1);integer(limit,'limit',1,200);
    integer(afterMessageId,'afterMessageId');
    let root=this.getMessage(chatId,messageId); const visited=new Set();
    if(!root) return {messages:[],hasMore:false};
    while(root.reply_to_message_id && !visited.has(root.message_id)) {
      visited.add(root.message_id); const parent=this.getMessage(chatId,root.reply_to_message_id);
      if(!parent || (parent.message_thread_id||0)!==(root.message_thread_id||0)) break;
      root=parent;
    }
    const rows=this.db.prepare(`WITH RECURSIVE discussion(id) AS (
      SELECT ? UNION SELECT e.message FROM latest l JOIN events e ON e.seq=l.seq
      JOIN discussion d ON CAST(json_extract(e.payload,'$.reply_to_message_id') AS INTEGER)=d.id
      WHERE e.chat=? AND e.topic=?)
      SELECT e.* FROM latest l JOIN events e ON e.seq=l.seq JOIN discussion d ON d.id=e.message
      WHERE e.chat=? AND e.message>? AND e.kind='content' ORDER BY e.message LIMIT ?`)
      .all(root.message_id,chatId,root.message_thread_id||0,chatId,afterMessageId,limit+1);
    const messages=rows.slice(0,limit).map(r=>this.#decode(r));
    return {messages,nextMessageId:messages.at(-1)?.message_id??afterMessageId,hasMore:rows.length>limit};
  }
  search({chatId,query,topicId,afterMessageId=0,limit=50}) {
    integer(chatId,'chatId',-Number.MAX_SAFE_INTEGER);integer(limit,'limit',1,200);integer(afterMessageId,'afterMessageId');
    if(typeof query!=='string'||!query.trim()||query.length>1000) throw new Error('invalid search query');
    const args=[chatId,afterMessageId,query];
    let topic=''; if(topicId!==undefined) {integer(topicId,'topicId');topic=' AND e.topic=?';args.push(topicId);}
    const rows=this.db.prepare(`SELECT e.* FROM latest l JOIN events e ON e.seq=l.seq
      WHERE e.chat=? AND e.message>? AND instr(lower(e.text),lower(?))>0 AND e.kind='content'${topic}
      ORDER BY e.message LIMIT ?`).all(...args,limit+1);
    const messages=rows.slice(0,limit).map(r=>this.#decode(r));
    return {messages,nextMessageId:messages.at(-1)?.message_id??afterMessageId,hasMore:rows.length>limit};
  }
  getState(key) {const row=this.db.prepare('SELECT value FROM state WHERE key=?').get(key);return row?JSON.parse(row.value):undefined;}
  setState(key,value) {this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  beginPost(expert,key,body) {
    if(typeof key!=='string'||!key.trim()||key.length>200) throw new Error('idempotency key is required');
    const fingerprint=hash(body);const prior=this.db.prepare('SELECT * FROM posts WHERE expert=? AND key=?').get(expert,key);
    if(prior) {
      if(prior.hash!==fingerprint) throw new Error('idempotency key already belongs to a different post');
      return {status:prior.status,result:prior.result?JSON.parse(prior.result):undefined};
    }
    this.db.prepare("INSERT INTO posts(expert,key,hash,status) VALUES(?,?,?,'pending')").run(expert,key,fingerprint);
    return {status:'new'};
  }
  finishPost(expert,key,record) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event=this.append(record);
      this.db.prepare("UPDATE posts SET status='completed',result=? WHERE expert=? AND key=?").run(JSON.stringify(event),expert,key);
      this.db.exec('COMMIT'); return event;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  close() {if(this.db) {this.db.close();this.db=undefined;}}
}
