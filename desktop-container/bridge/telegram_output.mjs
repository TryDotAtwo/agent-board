import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {createHash} from 'node:crypto';
import { splitTelegramText } from "./bridge_core.mjs";

const OUTBOX_ROOT = path.resolve(process.env.OUTBOX_ROOT || "/data/outbox");
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const SECRET_PATH = /(^|[\\/])(?:\.env(?:\..*)?|auth\.json|cookies?(?:\..*)?|credentials?(?:\..*)?|.*(?:token|secret|private[_-]?key).*|.*\.(?:pem|key))($|[\\/])/i;

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function safeArtifactFile(artifact) {
  if (!artifact?.artifactId) throw new Error("registered artifactId is required");
  const root = await realpath(OUTBOX_ROOT);
  const manifestText = await readFile(path.join(root, "manifest.jsonl"), "utf8");
  const registered = manifestText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .find((record) => record.artifactId === artifact.artifactId);
  if (!registered) throw new Error("artifact is not registered in the outbox manifest");
  const file = await realpath(String(registered.path || ""));
  if (path.resolve(String(artifact.path || "")) !== path.resolve(registered.path)) throw new Error("artifact path does not match its manifest record");
  if (artifact.mimeType !== registered.mimeType) throw new Error("artifact MIME type does not match its manifest record");
  if (!within(root, file)) throw new Error("artifact is outside the Telegram outbox");
  if (SECRET_PATH.test(file)) throw new Error("secret-like artifact paths are forbidden");
  const info = await stat(file);
  if (!info.isFile()) throw new Error("artifact must be a regular file");
  if (info.size !== registered.size) throw new Error("artifact size changed after registration");
  if (info.size > MAX_FILE_BYTES) throw new Error("artifact exceeds 50 MiB");
  const bytes=await readFile(file);
  if(artifact.sha256!==undefined&&createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw new Error('artifact content hash changed after snapshot');
  return { file, bytes, name: path.basename(file) };
}

export function classifyArtifact(artifact) {
  return ["image/png", "image/jpeg", "image/webp"].includes(artifact?.mimeType) ? "photo" : "document";
}

export class PermanentTelegramError extends Error {
  constructor(message, status) { super(message); this.name = "PermanentTelegramError"; this.status = status; }
}

export class TelegramBotClient {
  constructor({ token, fetchImpl = globalThis.fetch, retryDelays = [500, 1500, 3000], onMessage, onObserverError = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    if (!token) throw new Error("Telegram bot token is required");
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetch = fetchImpl;
    this.retryDelays = retryDelays;
    this.sleep = sleep;
    this.onMessage = onMessage;
    this.onObserverError = onObserverError;
  }

  async request(method, body, meta = { kind: "content" }) {
    const multipart = body instanceof FormData;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.fetch(`${this.baseUrl}/${method}`, {
          method: "POST", headers: multipart ? undefined : { "content-type": "application/json" },
          body: multipart ? body : JSON.stringify(body),
        });
        const payload = await response.json();
        if (response.ok && payload.ok) {
          if (this.onMessage && /^send/.test(method)) {
            for (const message of Array.isArray(payload.result) ? payload.result : [payload.result]) {
              // A journal failure must never retry an already successful Telegram send.
              try { await this.onMessage(message, meta); }
              catch (error) { try { await this.onObserverError(error); } catch {} }
            }
          }
          return payload.result;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) throw new PermanentTelegramError(payload.description || `Telegram ${method} failed`, response.status);
        if (attempt >= this.retryDelays.length) throw new Error(payload.description || `Telegram ${method} failed`);
        const retryAfter = Number(payload.parameters?.retry_after) * 1000;
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : this.retryDelays[attempt]);
      } catch (error) {
        const code = error?.cause?.code || error?.code;
        const transient = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN"]).has(code);
        if (!transient || attempt >= this.retryDelays.length) throw error;
        await this.sleep(this.retryDelays[attempt]);
      }
    }
  }

  sendText({ chatId, text, replyTo, topicId, deliveryKind = "content" }) {
    return this.request("sendMessage", { chat_id: chatId, text,
      ...(topicId ? { message_thread_id: topicId } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) }, { kind: deliveryKind });
  }

  async downloadFile(fileId) {
    const metadata = await this.request("getFile", { file_id: fileId });
    const response = await this.fetch(`${this.baseUrl.replace("/bot", "/file/bot")}/${metadata.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async singleFile(method, field, { chatId, artifact, replyTo, topicId }) {
    const file = await safeArtifactFile(artifact);
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (topicId) form.set("message_thread_id", String(topicId));
    form.set(field, new Blob([file.bytes], { type: artifact.mimeType }), file.name);
    if (artifact.caption) form.set("caption", String(artifact.caption).slice(0, 1024));
    if (replyTo) form.set("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    return this.request(method, form);
  }

  sendPhoto(body) { return this.singleFile("sendPhoto", "photo", body); }
  sendDocument(body) { return this.singleFile("sendDocument", "document", body); }

  async sendMediaGroup({ chatId, artifacts, replyTo, topicId }) {
    const files = await Promise.all(artifacts.map(safeArtifactFile));
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (topicId) form.set("message_thread_id", String(topicId));
    form.set("media", JSON.stringify(artifacts.map((artifact, index) => ({ type: "photo", media: `attach://file${index}`,
      ...(artifact.caption ? { caption: String(artifact.caption).slice(0, 1024) } : {}) }))));
    files.forEach((file, index) => form.set(`file${index}`, new Blob([file.bytes], { type: artifacts[index].mimeType }), file.name));
    if (replyTo) form.set("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    return this.request("sendMediaGroup", form);
  }
}

export async function sendFinalResponse({ client, chatId, replyTo, text, artifacts = [], recordDelivery = async () => {} }) {
  const chunks = splitTelegramText(text);
  for (let index = 0; index < chunks.length; index += 1) {
    await client.sendText({ chatId, text: chunks[index], replyTo: index === 0 ? replyTo : undefined });
  }
  const selected = artifacts.slice(0, 10);
  if (artifacts.length > selected.length) await client.sendText({ chatId, text: "Telegram: отправлены первые 10 вложений; остальные пропущены из-за лимита." });
  const photos = selected.filter((artifact) => classifyArtifact(artifact) === "photo");
  const documents = selected.filter((artifact) => classifyArtifact(artifact) === "document");
  if (photos.length === 1) {
    try { await client.sendPhoto({ chatId, artifact: photos[0] }); await recordDelivery(photos[0].artifactId, "delivered"); }
    catch (error) { await recordDelivery(photos[0].artifactId, "failed"); await client.sendText({ chatId, text: `Не удалось отправить ${path.basename(photos[0].path)}: ${error.message}` }); }
  } else if (photos.length > 1) {
    try { await client.sendMediaGroup({ chatId, artifacts: photos }); for (const item of photos) await recordDelivery(item.artifactId, "delivered"); }
    catch (error) { for (const item of photos) await recordDelivery(item.artifactId, "failed"); await client.sendText({ chatId, text: `Не удалось отправить альбом: ${error.message}` }); }
  }
  for (const artifact of documents) {
    try { await client.sendDocument({ chatId, artifact }); await recordDelivery(artifact.artifactId, "delivered"); }
    catch (error) { await recordDelivery(artifact.artifactId, "failed"); await client.sendText({ chatId, text: `Не удалось отправить ${path.basename(artifact.path)}: ${error.message}` }); }
  }
}
