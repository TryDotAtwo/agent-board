function attachments(message) {
  const photo = message.photo?.at?.(-1);
  return [
    ["document", message.document], ["photo", photo], ["video", message.video],
    ["audio", message.audio], ["voice", message.voice],
  ].filter(([, item]) => item?.file_id).map(([kind, item]) => ({ kind, ...item,
    ...(message.media_group_id ? { media_group_id: message.media_group_id } : {}) }));
}

function normalized(update) {
  const message = update.edited_message || update.message;
  if (!message) return null;
  return { messageId: message.message_id, edit: Boolean(update.edited_message), sender: message.from,
    replyTo: message.reply_to_message?.message_id, text: String(message.text || message.caption || "").trim(),
    attachments: attachments(message) };
}

export class TelegramAnswerCollector {
  constructor({ requestMessageId, experts, silenceMs = 2000, now = Date.now }) {
    Object.assign(this, { requestMessageId, silenceMs, now });
    this.byBot = new Map();
    this.streams = new Map();
    for (const expert of experts) {
      this.byBot.set(Number(expert.botId), expert.id);
      this.streams.set(expert.id, { status: "waiting", parts: new Map(), lastAt: 0, closed: false });
    }
  }

  accept(update) {
    const item = normalized(update);
    if (!item?.sender?.is_bot) return "ignored";
    const expertId = this.byBot.get(Number(item.sender.id));
    if (!expertId) return "ignored";
    const stream = this.streams.get(expertId);
    if (stream.closed) return "ignored";
    if (stream.status === "waiting") {
      if (item.replyTo !== this.requestMessageId) return "ignored";
      stream.status = "collecting";
    }
    stream.parts.set(item.messageId, item);
    stream.lastAt = this.now();
    return stream.parts.size === 1 && !item.edit ? "opened" : item.edit ? "updated" : "appended";
  }

  finish() {
    const current = this.now();
    for (const stream of this.streams.values()) {
      if (stream.status === "collecting" && current - stream.lastAt >= this.silenceMs) {
        stream.status = "answered";
        stream.closed = true;
      }
    }
    return [...this.streams.values()].every((stream) => stream.closed);
  }

  timeout() {
    for (const stream of this.streams.values()) {
      if (stream.status === "waiting") stream.status = "timeout";
      else if (stream.status === "collecting") { stream.status = "answered"; stream.partial = true; }
      stream.closed = true;
    }
  }

  result() {
    return Object.fromEntries([...this.streams].map(([expertId, stream]) => {
      const parts = [...stream.parts.values()].sort((a, b) => a.messageId - b.messageId);
      return [expertId, {
        status: stream.status,
        text: parts.map((part) => part.text).filter(Boolean).join("\n\n"),
        attachments: parts.flatMap((part) => part.attachments),
        partial: Boolean(stream.partial),
      }];
    }));
  }
}
