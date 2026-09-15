import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SECRET = /(?:^|[._-])(?:auth|credential|cookie|secret|token|private[_-]?key)(?:[._-]|$)|\.(?:pem|key)$/i;

function safeSegment(value, label) {
  const raw = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw) || raw === "." || raw === "..") throw new Error(`invalid ${label}`);
  return raw;
}

function safeFileName(value, fallback) {
  const name = path.basename(String(value || fallback)).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-160);
  if (!name || SECRET.test(name)) throw new Error("secret-like attachment filename is forbidden");
  return name;
}

export class RequestAttachmentStore {
  constructor({ root = "/data/mcp-telegram", download, maxBytes = 20 * 1024 * 1024 }) {
    Object.assign(this, { root: path.resolve(root), download, maxBytes });
  }

  async save(requestId, expertId, items = []) {
    const request = safeSegment(requestId, "request id");
    const expert = safeSegment(expertId, "expert id");
    const directory = path.join(this.root, request, expert);
    await mkdir(directory, { recursive: true });
    const unique = new Map();
    for (const item of items) unique.set(String(item.file_unique_id || item.file_id), item);
    const results = [];
    for (const item of unique.values()) {
      const name = safeFileName(item.file_name, `${item.kind || "file"}-${item.file_unique_id || item.file_id}.bin`);
      try {
        if (Number(item.file_size || 0) > this.maxBytes) throw new Error("attachment size exceeds limit");
        const bytes = Buffer.from(await this.download(item));
        if (bytes.length > this.maxBytes) throw new Error("attachment size exceeds limit");
        const file = path.join(directory, name);
        await writeFile(file, bytes);
        results.push({ ...item, path: file, file_name: name, size: bytes.length });
      } catch (error) {
        results.push({ ...item, file_name: name, error: String(error?.message || error) });
      }
    }
    return results;
  }
}
