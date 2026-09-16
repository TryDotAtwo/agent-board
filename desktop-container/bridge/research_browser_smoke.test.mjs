import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {PlaywrightMcpPool} from './playwright_mcp_pool.mjs';
test('real headed browsers isolate identities and preserve profile state when reopened',{skip:process.env.RUN_BROWSER_SMOKE!=='1'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'research-browser-'));
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Container browser verification</title><p>Local test page</p>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const options={outputRoot:path.join(root,'outputs'),profileRoot:path.join(root,'profiles'),headless:false};
 let pool=new PlaywrightMcpPool(options);
 try{
  for(const id of ['sol_ultra','frontier_pro']){
   await pool.startExpert(id);const nav=await pool.call(id,'browser_navigate',{url});assert.ok(!nav.isError,JSON.stringify(nav));
   const result=await pool.call(id,'browser_evaluate',{function:`()=>{localStorage.setItem('identity',${JSON.stringify(id)});return document.title;}`});
   assert.ok(!result.isError,JSON.stringify(result));assert.match(JSON.stringify(result),/Container browser verification/);
  }
  for(const id of ['sol_ultra','frontier_pro']){
   const result=await pool.call(id,'browser_evaluate',{function:"()=>localStorage.getItem('identity')"});assert.match(JSON.stringify(result),new RegExp(id));
   await pool.call(id,'browser_close',{});
  }
  pool.close();pool=new PlaywrightMcpPool(options);await pool.startExpert('sol_ultra');
  const nav=await pool.call('sol_ultra','browser_navigate',{url});assert.ok(!nav.isError,JSON.stringify(nav));
  const result=await pool.call('sol_ultra','browser_evaluate',{function:"()=>localStorage.getItem('identity')"});assert.match(JSON.stringify(result),/sol_ultra/);
  await pool.call('sol_ultra','browser_close',{});
 }finally{pool.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
