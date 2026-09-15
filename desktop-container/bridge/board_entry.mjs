import {DesktopMcpClient} from './desktop_mcp_client.mjs';
const id=process.env.CODEX_THREAD_ID;
const client=new DesktopMcpClient({targetThreadId:id,sourceThreadId:process.env.CODEX_THREAD_ID,
 serverPath:process.env.PRO_DESKTOP_MCP_SERVER});
await client.start();
for(;;){
 const result=await client.readThread({turnLimit:1,maxOutputCharsPerItem:0});
 const data=JSON.parse(result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
 if(data.thread.status.type==='idle')break;
 await new Promise(r=>setTimeout(r,1500));
}
client.close();
await import('./bridge.mjs');
