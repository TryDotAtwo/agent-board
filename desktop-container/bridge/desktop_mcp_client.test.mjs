import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DesktopMcpClient } from "./desktop_mcp_client.mjs";

const catalog = [
  { name: "read_thread", description: "Read a task", inputSchema: { type: "object", properties: {
    threadId: { type: "string" }, turnLimit: { type: "integer", minimum: 1, maximum: 10 },
    maxOutputCharsPerItem: { type: "integer", minimum: 0, maximum: 20000 },
  } } },
  { name: "send_message_to_thread", description: "Send a message", inputSchema: { type: "object", properties: { threadId: { type: "string" }, prompt: { type: "string" } } } },
];

// The only substituted dependency is the external stock MCP process. Requests,
// framing, response correlation, argument validation, and timeouts stay real.
class FakeMcpProcess extends EventEmitter {
  constructor({ tools = catalog, onRequest } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.requests = [];
    this.kills = 0;
    this.reader = createInterface({ input: this.stdin });
    this.reader.on("line", (line) => {
      const request = JSON.parse(line);
      this.requests.push(request);
      if (onRequest?.(request, this) === true) return;
      if (request.method === "initialize") this.respond(request.id, {
        protocolVersion: "2025-03-26", capabilities: { tools: {} },
        serverInfo: { name: "codex-app-tools", version: "0.1.0" },
      });
      if (request.method === "tools/list") this.respond(request.id, { tools });
      if (request.method === "tools/call") this.respond(request.id, { content: [{ type: "text", text: "ok" }], isError: false });
    });
  }
  respond(id, result) { queueMicrotask(() => this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)); }
  kill() { this.kills += 1; this.reader.close(); this.stdin.end(); this.stdout.end(); this.stderr.end(); this.emit("close", 0, null); }
}

test("initializes the stock protocol before listing and preserves the advertised tool catalog", async (t) => {
  const child = new FakeMcpProcess();
  const client = new DesktopMcpClient({ sourceThreadId: "executor-source", targetThreadId: "chat-target", spawnServer: () => child });
  t.after(() => client.close());
  assert.deepEqual(await client.start(), catalog);
  assert.deepEqual(child.requests.map((request) => request.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.equal(child.requests[0].params.protocolVersion, "2025-03-26");
  assert.deepEqual(client.tools, catalog);
});

function setup(t, serverOptions = {}, clientOptions = {}) {
  const child = new FakeMcpProcess(serverOptions);
  const client = new DesktopMcpClient({ sourceThreadId: "executor-source", targetThreadId: "chat-target",
    spawnServer: () => child, requestTimeoutMs: 30, listToolsRetryMs: 1, ...clientOptions });
  t.after(() => client.close());
  return { child, client };
}

test("uses the executor in metadata and the fixed Chat target in read and send arguments", async (t) => {
  const { child, client } = setup(t);
  await client.start();
  assert.equal(typeof client.readThread, "function", "target-bound readThread is missing");
  await client.readThread({ turnLimit: 4, maxOutputCharsPerItem: 20000 });
  await client.sendMessage("An explicitly authorized prompt");
  const calls = child.requests.filter((request) => request.method === "tools/call");
  assert.deepEqual(calls.map((request) => request.params), [
    { name: "read_thread", arguments: { threadId: "chat-target", turnLimit: 4, maxOutputCharsPerItem: 20000 },
      _meta: { "x-codex-turn-metadata": { thread_id: "executor-source" } } },
    { name: "send_message_to_thread", arguments: { threadId: "chat-target", prompt: "An explicitly authorized prompt" },
      _meta: { "x-codex-turn-metadata": { thread_id: "executor-source" } } },
  ]);
});

test("live stock read_thread bounds are rejected locally and inclusive endpoints remain callable", async (t) => {
  const { child, client } = setup(t);
  await client.start();
  for (const turnLimit of [0, 11, 100]) await assert.rejects(() => client.readThread({ turnLimit }), /turnLimit must be between 1 and 10/);
  for (const maxOutputCharsPerItem of [-1, 20001, 1000000]) {
    await assert.rejects(() => client.readThread({ maxOutputCharsPerItem }), /maxOutputCharsPerItem must be between 0 and 20000/);
  }
  await client.readThread({ turnLimit: 10, maxOutputCharsPerItem: 20000 });
  await client.readThread({ turnLimit: 1, maxOutputCharsPerItem: 0 });
  assert.deepEqual(child.requests.filter((request) => request.method === "tools/call").map((request) => request.params.arguments), [
    { threadId: "chat-target", turnLimit: 10, maxOutputCharsPerItem: 20000 },
    { threadId: "chat-target", turnLimit: 1, maxOutputCharsPerItem: 0 },
  ]);
});

test("requires nonempty source and target identities without inventing a caller", () => {
  const base = { spawnServer: () => new FakeMcpProcess(), sourceThreadId: "executor", targetThreadId: "target" };
  for (const sourceThreadId of ["", "   ", null, 42]) assert.throws(() => new DesktopMcpClient({ ...base, sourceThreadId }), /sourceThreadId/);
  for (const targetThreadId of ["", "   ", null, 42]) assert.throws(() => new DesktopMcpClient({ ...base, targetThreadId }), /targetThreadId/);
});

test("retries only a valid empty catalog and eventually uses the advertised tools", async (t) => {
  let attempts = 0;
  const { client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/list") return false;
    child.respond(request.id, { tools: ++attempts < 3 ? [] : catalog });
    return true;
  } }, { listToolsAttempts: 3 });
  assert.deepEqual(await client.start(), catalog);
  assert.equal(attempts, 3);
});

test("an exhausted empty catalog stays empty and cannot authorize a call", async (t) => {
  const { child, client } = setup(t, { tools: [] }, { listToolsAttempts: 2 });
  assert.deepEqual(await client.start(), []);
  assert.equal(typeof client.callTool, "function", "allowlisted callTool is missing");
  await assert.rejects(() => client.callTool("read_thread", {}), /not advertised|unavailable/);
  assert.equal(child.requests.filter((request) => request.method === "tools/list").length, 2);
  assert.equal(child.requests.filter((request) => request.method === "tools/call").length, 0);
});

test("advertising unrelated tools does not expand the fixed call allowlist", async (t) => {
  const { child, client } = setup(t, { tools: [...catalog, { name: "delete_thread", inputSchema: { type: "object" } }] });
  await client.start();
  assert.equal(typeof client.callTool, "function", "allowlisted callTool is missing");
  await assert.rejects(() => client.callTool("delete_thread", {}), /unsupported/);
  await assert.rejects(() => client.callTool("read_thread", { threadId: "other-chat" }), /target|threadId/);
  await assert.rejects(() => client.callTool("send_message_to_thread", { prompt: "x", model: "gpt-5-pro" }), /unsupported|model/);
  await assert.rejects(() => client.callTool("read_thread", { hostId: "remote" }), /unsupported|hostId/);
  assert.equal(child.requests.filter((request) => request.method === "tools/call").length, 0);
});

test("an absent allowed tool remains unavailable even if the exposed catalog is mutated", async (t) => {
  const { child, client } = setup(t, { tools: [catalog[0]] });
  await client.start();
  client.tools.push(catalog[1]);
  assert.equal(typeof client.sendMessage, "function", "target-bound sendMessage is missing");
  await assert.rejects(() => client.sendMessage("x"), /not advertised|unavailable/);
  assert.equal(child.requests.filter((request) => request.method === "tools/call").length, 0);
});

test("correlates out-of-order responses and preserves a full long answer", async (t) => {
  const waiting = [];
  const longAnswer = "Answer Ω ".repeat(24000);
  const { client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    waiting.push(request);
    if (waiting.length === 2) {
      child.respond(waiting[1].id, { content: [{ type: "text", text: longAnswer }], isError: false });
      child.respond(waiting[0].id, { content: [{ type: "text", text: "first" }], isError: false });
    }
    return true;
  } });
  await client.start();
  assert.equal(typeof client.readThread, "function", "target-bound readThread is missing");
  const [first, second] = await Promise.all([client.readThread(), client.readThread()]);
  assert.equal(first.content[0].text, "first");
  assert.equal(second.content[0].text, longAnswer);
});

test("an unanswered send times out as ambiguous and is never retried", async (t) => {
  const { child, client } = setup(t, { onRequest(request) { return request.method === "tools/call"; } });
  await client.start();
  assert.equal(typeof client.sendMessage, "function", "target-bound sendMessage is missing");
  await assert.rejects(() => client.sendMessage("send exactly once"), (error) => error.code === "MCP_TIMEOUT" && error.ambiguous === true);
  assert.equal(child.requests.filter((request) => request.method === "tools/call").length, 1);
});

test("rejects MCP isError results without treating them as a successful answer", async (t) => {
  const { client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    child.respond(request.id, { content: [{ type: "text", text: "backend refused" }], isError: true });
    return true;
  } });
  await client.start();
  assert.equal(typeof client.readThread, "function", "target-bound readThread is missing");
  await assert.rejects(() => client.readThread(), /backend refused/);
});

test("rejects malformed tool results instead of returning partial unvalidated data", async (t) => {
  const { client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    child.respond(request.id, { content: [{ type: "text", text: 123 }] });
    return true;
  } });
  await client.start();
  assert.equal(typeof client.readThread, "function", "target-bound readThread is missing");
  await assert.rejects(() => client.readThread(), /malformed/);
});

test("a malformed catalog fails without empty-catalog retries", async (t) => {
  let attempts = 0;
  const { client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/list") return false;
    attempts += 1;
    child.respond(request.id, { tools: null });
    return true;
  } });
  await assert.rejects(() => client.start(), /malformed/);
  assert.equal(attempts, 1);
});

test("close rejects pending calls and future calls and owns its process exactly once", async (t) => {
  const { child, client } = setup(t, { onRequest(request) { return request.method === "tools/call"; } });
  await client.start();
  assert.equal(typeof client.readThread, "function", "target-bound readThread is missing");
  const pending = assert.rejects(() => client.readThread(), /closed/);
  client.close();
  await pending;
  await assert.rejects(() => client.readThread(), /closed/);
  await assert.rejects(() => client.start(), /closed/);
  client.close();
  assert.equal(child.kills, 1);
});

test("JSON-RPC errors preserve failure and do not hang until the deadline", async (t) => {
  const { client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "bad arguments" } })}\n`));
    return true;
  } });
  await client.start();
  assert.equal(typeof client.readThread, "function", "target-bound readThread is missing");
  await assert.rejects(() => client.readThread(), (error) => error.code === -32602 && /bad arguments/.test(error.message));
});

test("a malformed send result is ambiguous and must not be retried", async (t) => {
  const { child, client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    child.respond(request.id, { content: "broken after the action may have happened" });
    return true;
  } });
  await client.start();
  await assert.rejects(() => client.sendMessage("one attempt"), (error) => error.code === "MCP_PROTOCOL" && error.ambiguous === true);
  assert.equal(child.requests.filter((request) => request.method === "tools/call").length, 1);
});

test("initialization timeout is bounded and does not list tools or retry initialization", async (t) => {
  const { child, client } = setup(t, { onRequest(request) { return request.method === "initialize"; } });
  await assert.rejects(() => client.start(), (error) => error.code === "MCP_TIMEOUT" && error.ambiguous === false);
  assert.deepEqual(child.requests.map((request) => request.method), ["initialize"]);
  assert.equal(child.kills, 1);
});

test("unexpected process closure rejects a pending send as ambiguous without resending", async (t) => {
  const { child, client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    queueMicrotask(() => child.emit("close", 1, null));
    return true;
  } });
  await client.start();
  await assert.rejects(() => client.sendMessage("one attempt"), (error) => error.code === "MCP_CLOSED" && error.ambiguous === true);
  assert.equal(child.requests.filter((request) => request.method === "tools/call").length, 1);
});

test("malformed framing fails closed instead of silently dropping the pending response", async (t) => {
  const { client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    queueMicrotask(() => child.stdout.write("{invalid-json}\n"));
    return true;
  } });
  await client.start();
  await assert.rejects(() => client.readThread(), (error) => error.code === "MCP_PROTOCOL");
  await assert.rejects(() => client.readThread(), /closed/);
});

test("JSON-RPC errors after send remain ambiguous while read failures are nonmutating", async (t) => {
  const { child, client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32603, message: "failed after possible dispatch" } })}\n`));
    return true;
  } });
  await client.start();
  await assert.rejects(() => client.sendMessage("one attempt"), (error) => error.code === -32603 && error.ambiguous === true);
  await assert.rejects(() => client.readThread(), (error) => error.code === -32603 && error.ambiguous === false);
  assert.equal(child.requests.filter((request) => request.method === "tools/call" && request.params.name === "send_message_to_thread").length, 1);
});

test("MCP isError after send remains ambiguous while a read isError is nonmutating", async (t) => {
  const { child, client } = setup(t, { onRequest(request, child) {
    if (request.method !== "tools/call") return false;
    child.respond(request.id, { content: [{ type: "text", text: "failed after possible dispatch" }], isError: true });
    return true;
  } });
  await client.start();
  await assert.rejects(() => client.sendMessage("one attempt"), (error) => error.code === "MCP_TOOL_ERROR" && error.ambiguous === true);
  await assert.rejects(() => client.readThread(), (error) => error.code === "MCP_TOOL_ERROR" && error.ambiguous === false);
  assert.equal(child.requests.filter((request) => request.method === "tools/call" && request.params.name === "send_message_to_thread").length, 1);
});
