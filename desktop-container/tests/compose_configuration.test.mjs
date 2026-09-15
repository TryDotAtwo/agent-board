import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const compose=fileURLToPath(new URL('../compose.yaml',import.meta.url));

// Exercise Compose's actual resolved deployment, not YAML source spelling.
// No daemon mutation, production .env, private credentials or config output.
async function resolveNode(overrides={}){
 const directory=await mkdtemp(path.join(tmpdir(),'board-compose-'));
 try{
  const envFile=path.join(directory,'empty.env');await writeFile(envFile,'');
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(BOARD_|COMPOSE_)/.test(key)||['KAGGLE_API_TOKEN','MOLAB_ENABLED'].includes(key))delete env[key];
  Object.assign(env,overrides);
  const result=spawnSync('docker',['compose','--env-file',envFile,'-f',compose,'config','--format','json'],{env,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,'Compose must resolve the controlled test configuration');
  return JSON.parse(result.stdout);
 }finally{await rm(directory,{recursive:true,force:true});}
}

test('default configuration preserves the existing deployment identity',async()=>{
 const config=await resolveNode();
 assert.equal(config.name,'collective-desktop');
 assert.equal(config.services.desktop.container_name,'collective-codex-desktop');
 assert.equal(config.volumes['desktop-home'].name,'collective-desktop_desktop-home');
 assert.equal(config.services.desktop.ports[0].published,'6080');
});

test('independent node settings isolate container, data, network, image tag and viewer port',async()=>{
 const nodes=[];
 for(const [suffix,port] of [['a','16080'],['b','16081']]){
  const config=await resolveNode({BOARD_PROJECT_NAME:`board-test-${suffix}`,BOARD_CONTAINER_NAME:`board-test-${suffix}-desktop`,BOARD_IMAGE:`board-test-${suffix}:local`,BOARD_VIEWER_PORT:port});
  const desktop=config.services.desktop;
  assert.equal(config.name,`board-test-${suffix}`);
  assert.equal(desktop.container_name,`board-test-${suffix}-desktop`);
  assert.equal(desktop.image,`board-test-${suffix}:local`);
  assert.equal(desktop.ports[0].published,port);
  assert.equal(desktop.ports[0].host_ip,'127.0.0.1');
  assert.equal(desktop.ports[0].target,6080);
  assert.equal(desktop.environment.KAGGLE_API_TOKEN,'');
  assert.equal(desktop.environment.MOLAB_ENABLED,'false');
  assert.ok(desktop.volumes.every(volume=>volume.type==='volume'));
  assert.ok(!desktop.privileged);
  assert.deepEqual(desktop.cap_drop,['ALL']);
  nodes.push(config);
 }
 for(const name of ['desktop-home','desktop-workspace'])assert.notEqual(nodes[0].volumes[name].name,nodes[1].volumes[name].name);
 assert.notEqual(nodes[0].networks.desktop.name,nodes[1].networks.desktop.name);
});
