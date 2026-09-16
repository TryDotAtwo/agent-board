// Transport availability must not depend on a research goal becoming idle.
// The participant adapter still owns its pre-send busy check.
export async function startBoardTransport({client,threadId,loadBridge}) {
  try {
    await client.start();
    const result=await client.readThread({turnLimit:1,maxOutputCharsPerItem:0});
    const data=JSON.parse(result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
    if(data.thread?.id!==threadId || typeof data.thread.status?.type!=='string')
      throw new Error('Desktop startup target/status unavailable');
  } finally { client.close(); }
  return loadBridge();
}
