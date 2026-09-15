import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {attachmentDownloadError,TELEGRAM_DOWNLOAD_LIMIT} from './bridge_core.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export class TelegramBoardAttachments {
  constructor({root,store}) {this.root=path.resolve(root);this.store=store;this.pending=new Map();}
  async download(record,telegram) {
    const attachments=await Promise.all((record.attachments||[]).map(async item=>{
      try {
        const error=attachmentDownloadError(item); if(error) throw new Error(error);
        const key=`file:${digest(String(item.file_unique_id||item.file_id))}`;
        if(!this.pending.has(key)) this.pending.set(key,this.#get(key,item,telegram).finally(()=>this.pending.delete(key)));
        return {...item,...await this.pending.get(key)};
      } catch(error) {return {...item,error:`download failed: ${error.message}`};}
    }));
    return {...record,attachments};
  }
  async #get(key,item,telegram) {
    await mkdir(this.root,{recursive:true});
    const saved=this.store.getState(key);
    if(saved?.sha256 && /^[a-f0-9]{64}$/.test(saved.sha256)) {
      const local_path=path.join(this.root,saved.sha256);
      try {
        const bytes=await readFile(local_path);
        if(digest(bytes)===saved.sha256) return {local_path,sha256:saved.sha256};
      } catch(error) {if(error.code!=='ENOENT') throw error;}
    }
    const bytes=await telegram.downloadFile(item.file_id);
    if(bytes.length>TELEGRAM_DOWNLOAD_LIMIT) throw new Error('attachment exceeds the shared download limit');
    const sha256=digest(bytes),local_path=path.join(this.root,sha256);
    try {await writeFile(local_path,bytes,{flag:'wx'});} catch(error) {
      if(error.code!=='EEXIST') throw error;
      if(digest(await readFile(local_path))!==sha256) throw new Error('shared attachment hash mismatch');
    }
    this.store.setState(key,{sha256});
    return {sha256,local_path};
  }
}
