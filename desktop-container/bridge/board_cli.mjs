import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {callBoardSocket} from './board_tool_socket.mjs';
import {telegramBoardTools} from './telegram_board_service.mjs';
import {researchTools} from './research_service.mjs';
const tools=[...telegramBoardTools,...researchTools];
export async function runBoardCli(argv,socket='/data/telegram-board/tools.sock') {
 if(argv[0]==='--socket'){
  if(typeof argv[1]!=='string'||!path.isAbsolute(argv[1]))throw new Error('--socket requires an absolute configured socket path');
  socket=argv[1];argv=argv.slice(2);
 }
 if(argv.length===0||argv[0]==='--help')return {
  usage:'node /opt/board/board_cli.mjs [--socket ABSOLUTE_PATH] TOOL JSON_ARGUMENTS',
  identity:'Fixed by the selected local socket; destination is its configured shared board',
  tools,
  warning:'For a post retry, preserve idempotency_key. An uncertain result is not permission to resend with a new key.'
 };
 if(argv.length>2||!tools.some(t=>t.name===argv[0]))throw new Error('Unknown operation; use --help');
 const args=JSON.parse(argv[1]||'{}');
 if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Arguments must be an object');
 return callBoardSocket(socket,{tool:argv[0],arguments:args});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await runBoardCli(process.argv.slice(2))));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
