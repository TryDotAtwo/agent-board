import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TelegramBotClient } from "./telegram_output.mjs";
import { RequestAttachmentStore } from "./request_attachment_store.mjs";
import { TelegramRequestBroker } from "./telegram_request_broker.mjs";
import { createRequesterHttpServer } from "./requester_http_server.mjs";

export async function resolveExpertBots(instances, externalExperts = []) {
  const local = await Promise.all(instances.map(async ({ config, telegram }) => {
    const identity = await telegram.request("getMe", {});
    if (!identity?.is_bot || !Number.isSafeInteger(Number(identity.id))) throw new Error(`invalid bot identity for ${config.id}`);
    const expected = String(config.username).replace(/^@/, "").toLowerCase();
    if (String(identity.username || "").toLowerCase() !== expected) throw new Error(`bot identity mismatch for ${config.id}`);
    return { id: config.id, username: config.username, botId: Number(identity.id) };
  }));
  if(!Array.isArray(externalExperts))throw new Error('External expert directory must be an array');
  const ids=new Set(local.map(x=>x.id)),names=new Set(local.map(x=>x.username.toLowerCase())),bots=new Set(local.map(x=>x.botId));
  for(const item of externalExperts) {
    if(!item||Object.keys(item).sort().join(',')!=='botId,id,username'||!Number.isSafeInteger(item.botId)||item.botId<1
      ||!/^\w+$/.test(item.id)||!/^\w+bot$/i.test(item.username)||ids.has(item.id)||names.has(item.username.toLowerCase())||bots.has(item.botId))
      throw new Error('Invalid or duplicate external expert');
    ids.add(item.id);names.add(item.username.toLowerCase());bots.add(item.botId);
  }
  return [...local,...externalExperts];
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, file);
}

export async function startTelegramRequester({ token, mcpToken, chatId, port = 48732,
  instances, externalExperts = [], dataRoot = "/data/mcp-telegram", log = async () => {} }) {
  if (!token || !mcpToken) return null;
  const numericChat = Number(chatId);
  if (!Number.isSafeInteger(numericChat)) throw new Error("requester Telegram chat id is invalid");
  await mkdir(dataRoot, { recursive: true });
  const statePath = path.join(dataRoot, "state.json");
  let state = { offset: 0 };
  try { state = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const requester = new TelegramBotClient({ token });
  const requesterIdentity = await requester.request("getMe", {});
  if (!requesterIdentity?.is_bot) throw new Error("requester token does not belong to a bot");
  const experts = await resolveExpertBots(instances, externalExperts);
  const attachmentStore = new RequestAttachmentStore({ root: dataRoot,
    download: (item) => requester.downloadFile(item.file_id) });
  const broker = new TelegramRequestBroker({ telegram: requester, chatId: numericChat, experts, attachmentStore });
  const server = createRequesterHttpServer({ broker, token: mcpToken, attachmentRoot: dataRoot, port: Number(port), host: "0.0.0.0" });
  const address = await server.start();
  let stopped = false;
  const ticker = setInterval(() => broker.tick().catch((error) => log(`requester tick failed: ${error.message}`)), 250);
  ticker.unref?.();
  const poll = async () => {
    while (!stopped) {
      try {
        const updates = await requester.request("getUpdates", { offset: state.offset || 0, timeout: 20,
          allowed_updates: ["message", "edited_message"] });
        for (const update of updates || []) {
          broker.acceptUpdate(update);
          state.offset = Math.max(state.offset || 0, update.update_id + 1);
        }
        if (updates?.length) await atomicJson(statePath, state);
      } catch (error) {
        await log(`requester poll failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };
  void poll();
  await log(`Telegram requester @${requesterIdentity.username} started on port ${address.port} for ${experts.length} experts`);
  return { broker, address, requesterId: Number(requesterIdentity.id), close: async () => {
    stopped = true; clearInterval(ticker); await server.close();
  } };
}
