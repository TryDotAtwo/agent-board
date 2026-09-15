import assert from "node:assert/strict";
import { classifyArtifact, sendFinalResponse, TelegramBotClient } from "./telegram_output.mjs";

let transientAttempts = 0;
const retryClient = new TelegramBotClient({ token: "test-token", retryDelays: [0, 0], sleep: async () => {}, fetchImpl: async () => {
  transientAttempts += 1;
  if (transientAttempts < 3) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 1 } }) };
} });
assert.deepEqual(await retryClient.request("getMe", {}), { id: 1 });
assert.equal(transientAttempts, 3);

let permanentAttempts = 0;
const noRetryClient = new TelegramBotClient({ token: "test-token", retryDelays: [0, 0], sleep: async () => {}, fetchImpl: async () => {
  permanentAttempts += 1;
  return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request" }) };
} });
await assert.rejects(() => noRetryClient.request("sendMessage", {}), /Bad Request/);
assert.equal(permanentAttempts, 1);

const downloadClient = new TelegramBotClient({ token: "test-token", fetchImpl: async (url) => {
  if (String(url).endsWith("/getFile")) return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: "docs/report.bin" } }) };
  if (String(url).includes("/file/bottest-token/docs/report.bin")) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("downloaded") };
  throw new Error(`unexpected URL ${url}`);
} });
assert.equal((await downloadClient.downloadFile("file-1")).toString("utf8"), "downloaded");

class FakeTelegram {
  constructor({ failIds = [] } = {}) { this.calls = []; this.failIds = new Set(failIds); }
  async sendText(body) { this.calls.push({ method: "text", ...body }); }
  async sendPhoto(body) { this.calls.push({ method: "photo", ...body }); if (this.failIds.has(body.artifact.artifactId)) throw new Error("photo failed"); }
  async sendMediaGroup(body) { this.calls.push({ method: "mediaGroup", ...body }); }
  async sendDocument(body) { this.calls.push({ method: "document", ...body }); if (this.failIds.has(body.artifact.artifactId)) throw new Error("document failed"); }
}

const png = (id) => ({ artifactId: id, path: `/data/outbox/${id}.png`, mimeType: "image/png", caption: id, delivered: false });
const notebook = (id) => ({ artifactId: id, path: `/data/outbox/${id}.ipynb`, mimeType: "application/x-ipynb+json", delivered: false });
assert.equal(classifyArtifact(png("p")), "photo");
assert.equal(classifyArtifact(notebook("n")), "document");

const longClient = new FakeTelegram();
await sendFinalResponse({ client: longClient, chatId: -1, replyTo: 42, text: "a".repeat(5000), artifacts: [] });
assert.deepEqual(longClient.calls.map((call) => call.text.length), [3800, 1200]);
assert.equal(longClient.calls[0].replyTo, 42);
assert.equal(longClient.calls[1].replyTo, undefined);

const photoClient = new FakeTelegram();
await sendFinalResponse({ client: photoClient, chatId: -1, replyTo: 1, text: "done", artifacts: [png("one")] });
assert.equal(photoClient.calls.at(-1).method, "photo");

const albumClient = new FakeTelegram();
await sendFinalResponse({ client: albumClient, chatId: -1, replyTo: 1, text: "done", artifacts: [png("one"), png("two"), notebook("book")] });
assert.deepEqual(albumClient.calls.slice(1).map((call) => call.method), ["mediaGroup", "document"]);

const delivery = [];
const failureClient = new FakeTelegram({ failIds: ["bad"] });
await sendFinalResponse({
  client: failureClient, chatId: -1, replyTo: 1, text: "done",
  artifacts: [notebook("bad"), notebook("good")],
  recordDelivery: async (id, status) => delivery.push({ id, status }),
});
assert.deepEqual(delivery, [{ id: "bad", status: "failed" }, { id: "good", status: "delivered" }]);
assert.ok(failureClient.calls.some((call) => call.method === "text" && /bad\.ipynb/.test(call.text)));

const cappedClient = new FakeTelegram();
await sendFinalResponse({ client: cappedClient, chatId: -1, replyTo: 1, text: "done", artifacts: Array.from({ length: 11 }, (_, i) => notebook(`n${i}`)) });
assert.equal(cappedClient.calls.filter((call) => call.method === "document").length, 10);
assert.ok(cappedClient.calls.some((call) => call.method === "text" && /10 вложений/.test(call.text)));
console.log("PASS Telegram text chunks, photos, media groups, documents, caps, and isolated failures");
