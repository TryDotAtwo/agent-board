import { appendFile, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SECRET_PATH = /(^|[\\/])(?:\.env(?:\..*)?|auth\.json|cookies?(?:\..*)?|credentials?(?:\..*)?|.*(?:token|secret|private[_-]?key).*|.*\.(?:pem|key))($|[\\/])/i;
const MIME = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"],
  [".gif", "image/gif"], [".ipynb", "application/x-ipynb+json"], [".json", "application/json"],
  [".csv", "text/csv"], [".md", "text/markdown"], [".txt", "text/plain"], [".pdf", "application/pdf"],
]);

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelative(value) {
  const raw = String(value || "").replaceAll("\\", "/");
  if (!raw || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) throw new Error("output path must be relative");
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== raw.replace(/^\.\//, "")) {
    throw new Error("output path traversal or escape is not allowed");
  }
  if (SECRET_PATH.test(`/${normalized}`)) throw new Error("secret-like output paths are forbidden");
  return normalized;
}

function mimeType(filePath) {
  return MIME.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

export class OutboxStore {
  constructor({ outboxRoot = "/data/outbox", allowedSourceRoots = [], maxBytes = 50 * 1024 * 1024 } = {}) {
    this.outboxRoot = path.resolve(outboxRoot);
    this.allowedSourceRoots = allowedSourceRoots.map((root) => path.resolve(root));
    this.maxBytes = maxBytes;
    this.manifestPath = path.join(this.outboxRoot, "manifest.jsonl");
  }

  async createArtifact({ relativePath, content, encoding = "utf8", turnId, caption = "" }) {
    const relative = safeRelative(relativePath);
    if (!turnId) throw new Error("turnId is required");
    if (!['utf8', 'base64'].includes(encoding)) throw new Error("encoding must be utf8 or base64");
    const bytes = Buffer.from(String(content ?? ""), encoding);
    if (bytes.length > this.maxBytes) throw new Error("artifact exceeds 50 MiB");
    const destination = await this.#destination(turnId, relative);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, destination);
    return this.#register({ turnId, destination, caption, size: bytes.length });
  }

  async publishArtifact({ sourcePath, outputName, turnId, caption = "" }) {
    if (!turnId) throw new Error("turnId is required");
    const source = await realpath(sourcePath);
    if (SECRET_PATH.test(source)) throw new Error("secret-like source paths are forbidden");
    const allowedRoots = await Promise.all(this.allowedSourceRoots.map((root) => realpath(root)));
    if (!allowedRoots.some((root) => within(root, source))) throw new Error("source path is outside an approved source root");
    const info = await stat(source);
    if (!info.isFile()) throw new Error("source must be a regular file");
    if (info.size > this.maxBytes) throw new Error("artifact exceeds 50 MiB");
    const destination = await this.#destination(turnId, safeRelative(outputName));
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await copyFile(source, temporary);
    await rename(temporary, destination);
    return this.#register({ turnId, destination, caption, size: info.size });
  }

  async listTurnArtifacts(turnId) {
    let text;
    try { text = await readFile(this.manifestPath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      .filter((record) => record.turnId === turnId);
  }

  async recordDelivery(artifactId, deliveryStatus) {
    if (!["delivered", "failed"].includes(deliveryStatus)) throw new Error("invalid delivery status");
    const text = await readFile(this.manifestPath, "utf8");
    const records = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const record = records.find((item) => item.artifactId === artifactId);
    if (!record) throw new Error("artifact is not registered");
    record.delivered = deliveryStatus === "delivered";
    record.deliveryStatus = deliveryStatus;
    record.deliveryUpdatedAt = new Date().toISOString();
    const temporary = `${this.manifestPath}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    await rename(temporary, this.manifestPath);
    return record;
  }

  async #destination(turnId, relative) {
    await mkdir(this.outboxRoot, { recursive: true });
    const root = await realpath(this.outboxRoot);
    const turnSegment = encodeURIComponent(String(turnId));
    if (!turnSegment || turnSegment.length > 240) throw new Error("invalid turnId");
    const destination = path.resolve(root, "turns", turnSegment, relative);
    if (!within(root, destination)) throw new Error("output path escapes outbox");
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true });
    const canonicalParent = await realpath(parent);
    if (!within(root, canonicalParent)) throw new Error("output parent escapes outbox through a symlink");
    return path.join(canonicalParent, path.basename(destination));
  }

  async #register({ turnId, destination, caption, size }) {
    const record = {
      artifactId: randomUUID(), turnId, path: destination, size,
      mimeType: mimeType(destination), caption: String(caption || "").slice(0, 1024),
      createdAt: new Date().toISOString(), delivered: false,
    };
    await appendFile(this.manifestPath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }
}
