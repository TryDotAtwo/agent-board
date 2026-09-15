import {ProSpoolClient} from './pro_spool_client.mjs';
import {ProBoardProtocol} from './pro_board_protocol.mjs';
import {telegramBoardTools} from './telegram_board_service.mjs';
import {researchTools} from './research_service.mjs';
import path from 'node:path';
export function createProClientMap({configs,boardHub,research,pollMs}){
 const selected=configs.filter(c=>c.backend==='desktop-chat');
 const roots=new Set();
 for(const config of selected){
  if(typeof config.proGatewayRoot!=='string'||!path.isAbsolute(config.proGatewayRoot))throw new Error('A private Pro spool root is required');
  const root=path.resolve(config.proGatewayRoot);
  if(roots.has(root))throw new Error('Each Pro participant requires a separate spool');
  roots.add(root);
 }
 return new Map(selected.map(config=>[config.id,createProClient({configs:[config],root:config.proGatewayRoot,boardHub,research,pollMs})]));
}
export function createProClient({configs,root,boardHub,pollMs,research}) {
  const config=configs.find(c=>c.backend==='desktop-chat' && c.board);
  if(config && !boardHub) throw new Error('Pro board needs its shared journal');
  const boardProtocol=config ? new ProBoardProtocol({root,
    tools:research?[...telegramBoardTools,...researchTools]:telegramBoardTools,
    call:async operation=>{
      const input={expertId:config.id,...operation};
      const result=await (research&&researchTools.some(t=>t.name===operation.tool)?research.call(input):boardHub.service.call(input));
      // Pro is text-only. Keep screenshots on disk via browser tools, never put base64 into its prompt.
      if(result?.content)return {...result,content:result.content.filter(x=>x.type==='text').map(x=>({...x,text:x.text.slice(0,8500)}))};
      return result;
    }}) : undefined;
  return new ProSpoolClient({root,pollMs,boardProtocol});
}
