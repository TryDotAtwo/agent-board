import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Removing discovery or guessing a cached version must break these fixtures.
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'board-desktop-path-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const root = path.join(home, '.codex/plugins/cache/openai-bundled/codex-app-tools');
  async function install(version) {
    const target = path.join(root, version, 'server.mjs');
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, 'throw new Error("Discovery must never execute this file");\n');
    return target;
  }
  return {home, root, install};
}
async function discover(args) {
  const module = await import('./desktop_server_path.mjs').catch(e => {
    if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw e;
  });
  assert.equal(typeof module.discoverDesktopServer, 'function', 'Desktop server discovery is required');
  return module.discoverDesktopServer(args);
}
test('discovers the sole installed version without executing its source', async t => {
  const f = await fixture(t), expected = await f.install('9.8.7');
  assert.equal(await discover({home: f.home}), expected);
});
test('reports an uninstalled plugin without inventing a fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(discover({home: f.home}), /not installed/i);
});
test('multiple cached versions require explicit selection, not newest guessing', async t => {
  const f = await fixture(t);
  await f.install('0.1.4'); await f.install('9.8.7');
  await assert.rejects(discover({home: f.home}), /multiple.*PRO_DESKTOP_MCP_SERVER/i);
});
test('explicit existing server resolves ambiguity', async t => {
  const f = await fixture(t), chosen = await f.install('0.1.4');
  await f.install('9.8.7');
  assert.equal(await discover({home: f.home, explicit: chosen}), chosen);
});
test('rejects relative or non-file explicit paths', async t => {
  const f = await fixture(t); await f.install('9.8.7');
  await assert.rejects(discover({home: f.home, explicit: 'server.mjs'}), /absolute/i);
  await assert.rejects(discover({home: f.home, explicit: f.root}), /regular file/i);
});
