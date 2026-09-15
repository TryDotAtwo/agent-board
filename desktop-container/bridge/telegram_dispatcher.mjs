function buildInput(record) {
  const files = (record.attachments || []).filter((item) => item.local_path);
  const nonImages = files.filter((item) => item.kind !== "photo" && !item.mime_type?.startsWith("image/"));
  const failed = (record.attachments || []).filter((item) => item.error);
  let text = `${record.sender}: ${record.text || "[attachment without caption]"}\nTelegram message_id=${record.message_id}`;
  if (nonImages.length) {
    text += `\n\nВложения доступны только на чтение:\n${nonImages.map((item) =>
      `- ${item.kind}: ${item.local_path} (${item.mime_type || "unknown"})`).join("\n")}`;
  }
  if (failed.length) {
    text += `\n\nНе удалось скачать:\n${failed.map((item) =>
      `- ${item.file_name || item.kind}: ${item.error}`).join("\n")}`;
  }
  const input = [{ type: "text", text }];
  for (const item of files) {
    if (item.kind === "photo" || item.mime_type?.startsWith("image/")) {
      input.push({ type: "localImage", path: item.local_path });
    }
  }
  return input;
}

export class TelegramDispatcher {
  constructor({ client, expertId = "default", readTextAttachment }) {
    this.client = client;
    this.expertId = expertId;
    this.readTextAttachment = readTextAttachment;
    this.chain = Promise.resolve();
  }

  dispatch(record) {
    if (!record.addressed) return Promise.resolve("ignored");
    const operation = this.chain.then(() => this.#dispatchAddressed(record));
    this.chain = operation.catch(() => {});
    return operation;
  }

  async prepareInput(record) {
    const prepared = await this.#prepareTextAttachments(record);
    let input = buildInput(prepared);
    if (record.board_delivery && this.client.supportsAttachments === false && prepared.attachments?.length) {
      const unavailable = prepared.attachments.map(item =>
        `${item.file_name || item.kind} (${item.mime_type || "unknown"}; SHA-256=${item.sha256 || "unknown"}): содержимое не передано в этот ChatGPT-чат${item.error ? `; ${item.error}` : ""}`).join("\n");
      input = buildInput({ ...prepared, attachments: [], text: `${prepared.text}\n\nВложения в журнале борды:\n${unavailable}` });
    } else if (this.client.supportsAttachments === false && prepared.attachments?.length) {
      input.push({ type: "unsupportedAttachment", count: prepared.attachments.length });
    }
    return input;
  }

  async #dispatchAddressed(record) {
    const input = await this.prepareInput(record);
    if (!this.client.getActiveTurnId(this.expertId)) {
      await this.client.startTurn(this.expertId, input);
      return "started";
    }
    try {
      await this.client.steerTurn(this.expertId, input);
      return "steered";
    } catch (error) {
      if (!/no active turn|active turn|expectedTurnId/i.test(String(error?.message || error))) throw error;
      await this.client.startTurn(this.expertId, input);
      return "started";
    }
  }

  async #prepareTextAttachments(record) {
    if (!this.readTextAttachment) return record;
    const remaining = [];
    let text = String(record.text || "");
    for (const item of record.attachments || []) {
      const textual = item.kind === "document" && item.local_path
        && (item.mime_type?.startsWith("text/") || item.mime_type === "application/json");
      if (!textual) { remaining.push(item); continue; }
      try {
        const content = await this.readTextAttachment(item);
        const addition = `\n\nСодержимое вложения ${item.file_name || "document"}:\n\n${content}`;
        if (typeof content !== "string" || text.length + addition.length > 18_000) remaining.push(item);
        else text += addition;
      } catch { remaining.push(item); }
    }
    return { ...record, text, attachments: remaining };
  }
}

export { buildInput as buildTelegramInput };
