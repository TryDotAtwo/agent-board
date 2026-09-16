import {DesktopMcpClient} from './desktop_mcp_client.mjs';
import {startBoardTransport} from './board_entry_policy.mjs';
const id=process.env.CODEX_THREAD_ID;
const client=new DesktopMcpClient({targetThreadId:id,sourceThreadId:process.env.CODEX_THREAD_ID,
 serverPath:process.env.PRO_DESKTOP_MCP_SERVER});
await startBoardTransport({client,threadId:id,loadBridge:()=>import('./bridge.mjs')});
