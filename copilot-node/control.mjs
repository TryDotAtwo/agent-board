import {readFile} from 'node:fs/promises';
import {callBoardSocket} from '../desktop-container/bridge/board_tool_socket.mjs';

try {
  const operation = process.argv[2] || 'status';
  if (operation === 'health') {
    const status = JSON.parse(await readFile('/data/status.json', 'utf8'));
    if (Date.now() - Date.parse(status.updatedAt) > 45000 ||
        !['running', 'paused', 'ready'].includes(status.status)) process.exitCode = 1;
  } else {
    if (!['status', 'activate', 'pause', 'resume', 'send'].includes(operation)) {
      throw new Error('Usage: node control.mjs status|activate|pause|resume|send');
    }
    let text = '';
    if (operation === 'send') {
      for await (const part of process.stdin) {
        text += part;
        if (Buffer.byteLength(text) > 50000) throw new Error('Owner input exceeds 50 KiB');
      }
      if (!text.trim()) throw new Error('Owner input is required on stdin');
    }
    const result = await callBoardSocket('/data/control.sock', {tool: operation, arguments: {text}});
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
