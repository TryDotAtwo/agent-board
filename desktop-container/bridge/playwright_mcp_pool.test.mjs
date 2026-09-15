import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlaywrightMcpPool, playwrightLaunchOptions } from "./playwright_mcp_pool.mjs";

function fakeProcess(expertId, calls) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.setEncoding("utf8");
  let pending = "";
  child.stdin.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: expertId, version: "test" } } })}\n`);
      } else if (message.method === "tools/list") {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "browser_navigate", description: "Navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }] } })}\n`);
      } else if (message.method === "tools/call") {
        calls.push({ expertId, ...message.params });
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${expertId}:${message.params.arguments.url}` }] } })}\n`);
      }
    }
  });
  child.kill = () => child.emit("close", 0, null);
  return child;
}

const spawns = [];
const calls = [];
const persistent=playwrightLaunchOptions({outputDir:'/tmp/files',profileDir:'/tmp/profile',headless:false});
assert.ok(!persistent.args.includes('--isolated'));assert.ok(!persistent.args.includes('--headless'));
assert.equal(persistent.args[persistent.args.indexOf('--user-data-dir')+1],'/tmp/profile');
assert.equal(persistent.spawnOptions.env?.KAGGLE_API_TOKEN,undefined);
assert.equal(playwrightLaunchOptions({outputDir:'/tmp/test'}).args[5], '/usr/local/bin/board-chromium');
const outputRoot = await mkdtemp(path.join(os.tmpdir(), "playwright-pool-"));
const launch = playwrightLaunchOptions({ outputDir: path.join(outputRoot, "beam"), executablePath: "/chromium" });
assert.equal(launch.spawnOptions.cwd, path.join(outputRoot, "beam"));
assert.deepEqual(launch.args.slice(0, 5), ["--headless", "--isolated", "--output-dir", path.join(outputRoot, "beam"), "--executable-path"]);
const pool = new PlaywrightMcpPool({
  outputRoot,
  spawnServer: (expertId, options) => {
    spawns.push({ expertId, options });
    return fakeProcess(expertId, calls);
  },
});

await Promise.all([pool.startExpert("beam"), pool.startExpert("vision")]);
assert.deepEqual(spawns.map(({ expertId }) => expertId).sort(), ["beam", "vision"]);
assert.notEqual(spawns[0].options.outputDir, spawns[1].options.outputDir);
assert.deepEqual(pool.toolsFor("beam").map(({ name }) => name), ["browser_navigate"]);

const [beamResult, visionResult] = await Promise.all([
  pool.call("beam", "browser_navigate", { url: "https://beam.test" }),
  pool.call("vision", "browser_navigate", { url: "https://vision.test" }),
]);
assert.equal(beamResult.content[0].text, "beam:https://beam.test");
assert.equal(visionResult.content[0].text, "vision:https://vision.test");
assert.deepEqual(calls.map(({ expertId }) => expertId).sort(), ["beam", "vision"]);
pool.close();
console.log("PASS Playwright MCP processes and output directories are isolated per expert");
