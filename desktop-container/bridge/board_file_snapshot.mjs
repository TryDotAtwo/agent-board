import {realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {OutboxStore} from './outbox_core.mjs';

const secret=/(^|[\\/])(?:\.env(?:\..*)?|auth\.json|cookies?(?:\..*)?|credentials?(?:\..*)?|.*(?:token|secret|private[_-]?key).*|.*\.(?:pem|key))($|[\\/])/i;
export function createBoardFilePreparer({outboxRoot,rootsFor,maxBytes=20*1024*1024}) {
  const outbox=new OutboxStore({outboxRoot,maxBytes});
  return async(expertId,args)=>{
    const source=await realpath(args.path);
    if(secret.test(source)||secret.test(args.path))throw new Error('secret-like file path is forbidden');
    const roots=await Promise.all(rootsFor(expertId).map(p=>realpath(p).catch(()=>null)));
    if(!roots.some(root=>{if(!root)return false;const r=path.relative(root,source);return r&&!r.startsWith('..')&&!path.isAbsolute(r);}))throw new Error('file is outside approved source roots');
    const handle=await open(source,'r');let bytes;
    try {
      const info=await handle.stat();
      if(!info.isFile()||info.size>maxBytes)throw new Error('file is not regular or exceeds upload limit');
      const buffer=Buffer.alloc(maxBytes+1);let used=0;
      while(used<buffer.length){const {bytesRead}=await handle.read(buffer,used,buffer.length-used,null);if(!bytesRead)break;used+=bytesRead;}
      if(used>maxBytes)throw new Error('file exceeds upload limit');
      bytes=buffer.subarray(0,used);
    } finally {await handle.close();}
    const artifact=await outbox.createArtifact({relativePath:path.basename(source),content:bytes.toString('base64'),encoding:'base64',turnId:`board-file-${randomUUID()}`,caption:args.caption??''});
    return {...artifact,sha256:createHash('sha256').update(bytes).digest('hex')};
  };
}
