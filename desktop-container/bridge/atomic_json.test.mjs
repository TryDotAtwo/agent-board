import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

async function implementation() {
  try { return (await import("./atomic_json.mjs")).atomicJson; }
  catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("sharing-aware atomic JSON persistence is not implemented"); throw error; }
}

async function fixture(t) {
  const data = tmpdir();
  const root = await mkdtemp(path.join(data, "atomic-json-"));
  assert(root.startsWith(`${data}${path.sep}atomic-json-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "result.json");
  await writeFile(file, '{"status":"queued"}\n');
  return { root, file };
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) test(`transient ${code} retries the same synced rename, preserving old ledger until success`, async (t) => {
  const atomicJson = await implementation();
  const f = await fixture(t);
  let attempts = 0;
  let temporary;
  await atomicJson(f.file, { status: "sending" }, { retryDelaysMs: [1, 1], async renameFile(source, target) {
    attempts++;
    if (temporary) assert.equal(source, temporary, "retry must reuse the same durable intent file");
    temporary = source;
    assert.equal(target, f.file);
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), { status: "sending" });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { status: "queued" });
    if (attempts < 3) throw Object.assign(new Error("sharing violation"), { code });
    return rename(source, target);
  } });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { status: "sending" });
  assert.deepEqual(await readdir(f.root), ["result.json"]);
});

test("exhausted sharing retry preserves the prior ledger and never unlinks the target", async (t) => {
  const atomicJson = await implementation();
  const f = await fixture(t);
  let attempts = 0;
  await assert.rejects(() => atomicJson(f.file, { status: "sending" }, { retryDelaysMs: [1, 1], async renameFile() {
    attempts++; throw Object.assign(new Error("busy"), { code: "EBUSY" });
  } }), { code: "EBUSY" });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { status: "queued" });
  assert.deepEqual(await readdir(f.root), ["result.json"]);
});

test("non-sharing rename errors fail immediately without retry", async (t) => {
  const atomicJson = await implementation();
  const f = await fixture(t);
  let attempts = 0;
  await assert.rejects(() => atomicJson(f.file, { status: "sending" }, { retryDelaysMs: [1, 1], async renameFile() {
    attempts++; throw Object.assign(new Error("disk failure"), { code: "EIO" });
  } }), { code: "EIO" });
  assert.equal(attempts, 1);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { status: "queued" });
});

async function waitReady(child) {
  let diagnostics = "";
  child.stderr.on("data", (value) => { diagnostics += value.toString().slice(0, 500); });
  const exit = once(child, "close");
  let timer;
  try {
    const ready = await Promise.race([once(child.stdout, "data").then(([value]) => value.toString()),
      exit.then(([code]) => { throw new Error(`file holder exited before readiness: ${code}; ${diagnostics}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`file holder readiness timeout; ${diagnostics}`)), 8000); })]);
    assert.match(ready, /locked/);
    return { exit };
  } finally { clearTimeout(timer); }
}

test("real Windows read handle without delete sharing rejects rename until released", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const replacement = path.join(f.root, "replacement.tmp");
  await writeFile(replacement, '{"status":"sending"}\n');
  const command = "$f=[System.IO.File]::Open($env:PRO_RENAME_TEST_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PRO_RENAME_TEST_FILE: f.file } });
  t.after(() => child.kill());
  const { exit } = await waitReady(child);
  let code;
  await assert.rejects(() => rename(replacement, f.file), (error) => { code = error.code; return ["EPERM", "EACCES", "EBUSY"].includes(code); });
  child.stdin.end("release\n");
  assert.equal((await exit)[0], 0);
  await rename(replacement, f.file);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).status, "sending");
  t.diagnostic(`real Windows held-file rename error: ${code}; same rename succeeded after release`);
});

test("Docker bind read sharing characterization uses only synthetic local files", { skip: !process.env.PRO_ATOMIC_DOCKER_IMAGE }, async (t) => {
  const atomicJson = await implementation();
  const f = await fixture(t);
  const replacement = path.join(f.root, "replacement.tmp");
  await writeFile(replacement, '{"status":"sending"}\n');
  const code = "const fs=require('node:fs');const h=fs.openSync('/spool/result.json','r');console.log('locked');process.stdin.once('data',()=>{fs.closeSync(h);process.exit(0)});process.stdin.resume();setTimeout(()=>process.exit(2),10000).unref();";
  const child = spawn("docker", ["run", "--pull", "never", "--rm", "-i", "--read-only", "--network", "none", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--memory", "128m", "--cpus", "0.25", "--pids-limit", "32",
    "--mount", `type=bind,src=${f.root},dst=/spool,readonly`, "--entrypoint", "node", process.env.PRO_ATOMIC_DOCKER_IMAGE, "-e", code],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const { exit } = await waitReady(child);
  let renameError = null;
  try { await rename(replacement, f.file); } catch (error) { renameError = error.code; }
  const release = setTimeout(() => child.stdin.end("release\n"), 80);
  try { await atomicJson(f.file, { status: "completed" }); }
  finally { clearTimeout(release); child.stdin.end("release\n"); }
  assert.equal((await exit)[0], 0);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).status, "completed");
  t.diagnostic(`Docker bind held-file rename error: ${renameError || "none"}; bounded atomicJson succeeded after release`);
});
test('ordered state writer snapshots inputs and recovers its queue after a failed write',async()=>{
 const {orderedJsonWriter}=await import('./atomic_json.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'ordered-state-'));
 try{
  const file=path.join(root,'state.json'),save=orderedJsonWriter(file),state={version:1};
  const first=save(state);state.version=2;const second=save(state);state.version=99;
  await Promise.all([first,second]);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{version:2});
  const invalid={};invalid.self=invalid;
  await assert.rejects(save(invalid));
  await save({version:3});assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{version:3});
  const directory=path.join(root,'late-directory'),lateFile=path.join(directory,'state.json');
  const lateSave=orderedJsonWriter(lateFile);
  await assert.rejects(lateSave({version:1}),{code:'ENOENT'});
  await mkdir(directory);await lateSave({version:2});
  assert.deepEqual(JSON.parse(await readFile(lateFile,'utf8')),{version:2});
 }finally{await rm(root,{recursive:true,force:true});}
});
