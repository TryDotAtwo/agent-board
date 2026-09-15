import { appendFile, lstat, mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import { orderedJsonWriter } from './atomic_json.mjs';
import { existsSync } from "node:fs";
import path from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { AppServerClient } from "./app_server_client.mjs";
import { DesktopCodexClient } from './desktop_codex_client.mjs';
import {startBoardToolSocket} from './board_tool_socket.mjs';
import {ResearchService,researchTools} from './research_service.mjs';
import { initializeExpertThread } from "./expert_startup.mjs";
import { createProClientMap } from "./pro_board_binding.mjs";
import { VmToolClient } from "./vm_tool_client.mjs";
import { BridgeRuntime } from "./bridge_runtime.mjs";
import { TelegramBotClient } from "./telegram_output.mjs";
import { OutboxStore } from "./outbox_core.mjs";
import { DeliveryQueue } from "./delivery_queue.mjs";
import { DeliveryWorker } from "./delivery_worker.mjs";
import { attachmentDownloadError } from "./bridge_core.mjs";
import { loadRuntimeConfiguration } from "./runtime_configuration.mjs";
import { historyCredentialsForContainer } from "./history_gateway_config.mjs";
import { createHistoryClient } from "./history_mcp.mjs";
import { dynamicToolSpecs } from "./dynamic_tool_specs.mjs";
import { TurnBoundToolDispatcher } from "./turn_bound_tools.mjs";
import { LeanToolClient } from "./lean_tool_client.mjs";
import { PlaywrightMcpPool } from "./playwright_mcp_pool.mjs";
import { startTelegramRequester } from "./telegram_requester_runtime.mjs";
import { createTelegramBoardHub } from "./telegram_board_hub.mjs";

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());
const rootDataDir = process.env.BRIDGE_DATA_DIR || "/data";
const {configs,configRaw,portable} = await loadRuntimeConfiguration({root:rootDataDir});
const boardHub = await createTelegramBoardHub({ configs, dataRoot: rootDataDir,
  log: async message => console.warn(`[board] ${message}`) });
const threadOptions = (config, dynamicTools, threadId) => ({
  ...(threadId ? { threadId } : {}), cwd: config.cwd, model: config.model, effort: config.effort,
  chatThreadId: config.chatThreadId,
  sandbox: config.sandbox, sandboxPolicy: config.sandboxPolicy,
  developerInstructions: config.developerInstructions, dynamicTools,
  threadConfig: config.threadConfig,
});
const historyCredentials = configRaw ? historyCredentialsForContainer({ raw: configRaw, env: process.env }) : {};
const safeName = (value) => String(value || "attachment").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-120) || "attachment";

const outboxRoot = path.join(rootDataDir, "outbox");
const outboxSourceRoots = (process.env.OUTBOX_SOURCE_ROOTS || "/tmp/.playwright-mcp:/data/outbox")
  .split(process.platform === "win32" ? ";" : ":").filter(Boolean);
await mkdir(outboxRoot, { recursive: true });
const sharedOutbox = new OutboxStore({ outboxRoot, allowedSourceRoots: outboxSourceRoots });
const history = createHistoryClient({ credentials: historyCredentials,
  gatewayUrl: process.env.HISTORY_GATEWAY_URL || "http://host.docker.internal:48731" });
const browserPool = new PlaywrightMcpPool({ outputRoot: path.join(rootDataDir, "research"),profileRoot:path.join(rootDataDir,'browser-profiles'),headless:false });
browserPool.on("stderr", ({ expertId, message }) => process.stderr.write(`[playwright:${expertId}] ${message}`));
browserPool.on("warning", ({ expertId, message }) => console.warn(`[playwright:${expertId}] ${message}`));
browserPool.on("fatal", ({ expertId, error }) => console.error(`[playwright:${expertId}] ${error.message}`));
const nativeConfigs = configs.filter(config => config.backend === "codex");
const proConfigs = configs.filter(config => config.backend === "desktop-chat");
await Promise.all(configs.map((config) => browserPool.startExpert(config.id)));
const research=new ResearchService({root:path.join(rootDataDir,'research'),browser:browserPool,agentIds:configs.map(c=>c.id)});
if(boardHub)for(const config of nativeConfigs.filter(c=>c.board))await startBoardToolSocket({
 socket:config.boardSocket,expertId:config.id,service:{call:input=>
  researchTools.some(t=>t.name===input.tool)?research.call(input):boardHub.service.call(input)}});
const toolsByExpert = new Map(configs.map((config) => [config.id,
  config.backend === "desktop-chat" ? [] : dynamicToolSpecs({ expertId: config.id, board: config.board,
    includeHistory: !config.board || Boolean(historyCredentials[config.id]),
    toolNamespaces: config.toolNamespaces, browserTools: browserPool.toolsFor(config.id) })]));
const lean = new LeanToolClient({
  workerSocket: process.env.LEAN_WORKER_SOCKET || "/run/lean-worker/worker.sock",
  validatorSocket: process.env.LEAN_VALIDATOR_SOCKET || "/run/lean-validator/validator.sock",
});
const vm = new VmToolClient({ socketPath: process.env.VM_EXECUTOR_SOCKET || "/run/vm/worker.sock" });
const toolDispatcher = new TurnBoundToolDispatcher({ history, outbox: sharedOutbox, browser: browserPool, lean, vm, board: boardHub?.service });
const client = new DesktopCodexClient({root:path.join(rootDataDir,'astra-desktop')});
const proClients = createProClientMap({configs,boardHub,research});
for(const [id,proClient]of proClients)proClient.on('warning',message=>console.warn(`[${id}] ${message}`));
if (nativeConfigs.length) await client.start();
const instances = [];

for (const config of configs) {
  const legacy = !portable && configs.length === 1 && config.id === "default" && !configRaw;
  const dataDir = legacy ? rootDataDir : path.join(rootDataDir, "experts", config.id);
  const statePath = path.join(dataDir, "state.json");
  const logPath = path.join(dataDir, "bridge.log");
  const heartbeatPath = path.join(dataDir, "heartbeat");
  const chatArchivePath = path.join(dataDir, "chat", "messages.jsonl");
  const attachmentsDir = path.join(dataDir, "attachments");
  await Promise.all([dataDir, path.dirname(chatArchivePath), attachmentsDir, outboxRoot].map((dir) => mkdir(dir, { recursive: true })));
  const log = async (message) => { const line = `${new Date().toISOString()} [${config.id}] ${message}`; console.log(line); await appendFile(logPath, `${line}\n`, "utf8"); };
  let state;
  try { state = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") state = { offset: 0 }; else throw error; }
  const saveState = orderedJsonWriter(statePath);
  const telegram = boardHub?.telegram(config) || new TelegramBotClient({ token: config.token });
  const archiveMessage = async (record) => {
    boardHub?.archive(record);
    await appendFile(chatArchivePath, `${JSON.stringify(record)}\n`, "utf8");
  };
  const downloadAttachments = async (record) => {
    if (boardHub?.includes(record.chat_id)) return boardHub.attachments.download(record, telegram);
    for (const item of record.attachments) {
      const limitError = attachmentDownloadError(item);
      if (limitError) { item.error = limitError; continue; }
      try {
        const suffix = item.file_name || `${item.file_unique_id || item.file_id}.${item.kind === "photo" ? "jpg" : "bin"}`;
        const localPath = path.join(attachmentsDir, `${record.message_id}_${safeName(suffix)}`);
        if (!existsSync(localPath)) {
          const metadata = await telegram.request("getFile", { file_id: item.file_id });
          const response = await fetch(`https://api.telegram.org/file/bot${config.token}/${metadata.file_path}`);
          if (!response.ok) throw new Error(`Telegram file download HTTP ${response.status}`);
          await writeFile(localPath, new Uint8Array(await response.arrayBuffer()));
        }
        item.local_path = localPath;
      } catch (error) { item.error = `download failed: ${error.message}`; await log(`attachment ${record.message_id} download failed: ${error.message}`); }
    }
    return record;
  };
  const readTextAttachment = async (item) => {
    const target = path.resolve(item.local_path || "");
    const roots = [attachmentsDir, ...(boardHub?.attachmentRoots || [])];
    if (!roots.some(root => { const relative = path.relative(path.resolve(root), target);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative); })) throw new Error("attachment path is outside expert storage");
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 18_000) throw new Error("text attachment is not a small regular file");
    return readFile(target, "utf8");
  };
  const tools = toolsByExpert.get(config.id);
  const expertClient = config.backend === "desktop-chat" ? proClients.get(config.id) : client;
  const started = await initializeExpertThread({ config, client: expertClient, state, log,
    options: threadId => threadOptions(config, tools, threadId) });
  if (!started) continue;
  state.threadId = expertClient.getThreadId(config.id);
  await saveState(state);
  const outbox = sharedOutbox;
  const deliveryQueue = new DeliveryQueue({ root: path.join(dataDir, "delivery-queue") });
  const deliveryWorker = new DeliveryWorker({ queue: deliveryQueue, client: telegram, recordDelivery: (id, status) => outbox.recordDelivery(id, status), log });
  const runtime = new BridgeRuntime({ expertId: config.id, client: expertClient, telegram, outbox, state, saveState, archiveMessage, downloadAttachments, readTextAttachment,
    boardEnabled: config.board,
    expectedChat: config.chatId, botUsername: config.username, outboxRoot, deliveryQueue, deliveryWorker, log,
    batchDelayMs: Number(process.env.MESSAGE_BATCH_MS || 1500) });
  await deliveryWorker.start();
  await runtime.restoreScheduler();
  await log(`bridge started with ${config.backend} thread ${state.threadId}`);
  const boardInbox = config.board ? boardHub.inbox(config, expertClient,
    record => runtime.dispatchBoardRecord(record),record=>runtime.reconcileBoardRecord(record)) : undefined;
  instances.push({ config, state, telegram, runtime, heartbeatPath, log, boardInbox });
}

let restarting = false;
// Transport polling only: no model call when there are no new original messages.
for (const instance of instances.filter(i => i.boardInbox)) {
  let lastProblem;
  setInterval(async () => {
    if (restarting) return;
    try {
      const result = await instance.boardInbox.tick();
      if (result === "blocked" && lastProblem !== result) await instance.log("board delivery has an uncertain pending dispatch; automatic replay paused for reconciliation");
      lastProblem = result === "blocked" ? result : undefined;
    } catch (error) {
      if (lastProblem !== error.message) await instance.log(`board delivery error: ${error.message}`);
      lastProblem = error.message;
    }
  }, 3000).unref();
}

await startTelegramRequester({
  token: process.env.TELEGRAM_BOT_TOKEN,
  mcpToken: process.env.TELEGRAM_MCP_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  port: Number(process.env.TELEGRAM_REQUESTER_PORT || 48732),
  instances,
  dataRoot: path.join(rootDataDir, "mcp-telegram"),
  log: async (message) => { const line = `${new Date().toISOString()} [requester] ${message}`; console.log(line); },
});

client.on("fatal", async (error) => {
  if (restarting) return;
  restarting = true;
  for (const instance of instances) await instance.log(`App Server fatal: ${error.message}; starting bounded recovery`);
  for (const seconds of [1, 2, 4, 8, 15]) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    try {
      client.close(); await client.start();
      for (const { config, state } of instances.filter(instance => instance.config.backend === "codex")) await client.startOrResumeThread(config.id,
        threadOptions(config, toolsByExpert.get(config.id), state.threadId));
      restarting = false;
      return;
    } catch (restartError) {
      for (const instance of instances) await instance.log(`App Server recovery attempt failed: ${restartError.message}`);
    }
  }
  process.exit(1);
});

async function poll(instance) {
  const { state, telegram, runtime, heartbeatPath, log } = instance;
  for (;;) {
    try {
      const updates = await telegram.request("getUpdates", { offset: state.offset || 0, timeout: 20,
        allowed_updates: ["message", "edited_message"] });
      if (!existsSync(heartbeatPath)) await writeFile(heartbeatPath, "");
      const now = new Date();
      await utimes(heartbeatPath, now, now);
      const rootHeartbeat = path.join(rootDataDir, "heartbeat");
      if (!existsSync(rootHeartbeat)) await writeFile(rootHeartbeat, "");
      await utimes(rootHeartbeat, now, now);
      await runtime.processUpdates(updates || []);
    } catch (error) { await log(`poll error: ${error.message}`); await new Promise((resolve) => setTimeout(resolve, 5000)); }
  }
}

await Promise.all(instances.map((instance) => poll(instance)));
