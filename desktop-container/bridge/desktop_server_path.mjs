import {readdir, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

async function regularFile(file) {
  try { return (await stat(file)).isFile(); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

// Discovery does not execute candidates or assume the highest cached version is active.
export async function discoverDesktopServer({home = homedir(), explicit = process.env.PRO_DESKTOP_MCP_SERVER} = {}) {
  if (explicit !== undefined && explicit !== '') {
    if (typeof explicit !== 'string' || !path.isAbsolute(explicit)) {
      throw new Error('PRO_DESKTOP_MCP_SERVER must be an absolute path');
    }
    if (!await regularFile(explicit)) throw new Error('PRO_DESKTOP_MCP_SERVER must point to an existing regular file');
    return explicit;
  }
  const root = path.join(home, '.codex/plugins/cache/openai-bundled/codex-app-tools');
  let entries;
  try { entries = await readdir(root, {withFileTypes: true}); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'server.mjs');
    if (await regularFile(file)) candidates.push(file);
  }
  candidates.sort();
  if (!candidates.length) throw new Error('Desktop codex-app-tools is not installed; open Desktop and install its bundled tools, or configure PRO_DESKTOP_MCP_SERVER');
  if (candidates.length > 1) throw new Error('Multiple Desktop tool versions are cached; set PRO_DESKTOP_MCP_SERVER to the active installed server');
  return candidates[0];
}
