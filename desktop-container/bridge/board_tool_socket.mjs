import http from 'node:http';
import {chmod} from 'node:fs/promises';
export async function startBoardToolSocket({socket,service,expertId='sol_ultra'}) {
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.method!=='POST'||req.url!=='/call')throw new Error('Unsupported operation');
   let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>100000)throw new Error('Request too large');}
   const value=JSON.parse(text);
   if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['tool','arguments'].includes(k)))throw new Error('Invalid request');
   const result=await service.call({expertId,tool:value.tool,arguments:value.arguments});
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({result}));
  }catch(error){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
 await chmod(socket,0o600);return server;
}
export function callBoardSocket(socket,value) {
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath:socket,path:'/call',method:'POST',timeout:30000,
   headers:{'content-type':'application/json'}},res=>{
    let text='';res.setEncoding('utf8');res.on('data',x=>text+=x);res.on('end',()=>{
     try{const data=JSON.parse(text);if(res.statusCode!==200)throw new Error(data.error||'Board error');resolve(data.result);}catch(e){reject(e);}
    });
   });
  req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Board request timed out; do not repeat an uncertain post')));
  req.end(JSON.stringify(value));
 });
}
