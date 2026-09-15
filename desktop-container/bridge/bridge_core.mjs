function attachment(kind, value) {
  if (!value?.file_id) return null;
  return {
    kind,
    file_id: value.file_id,
    file_unique_id: value.file_unique_id,
    file_name: value.file_name,
    mime_type: value.mime_type,
    file_size: value.file_size,
  };
}

export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export function attachmentDownloadError(item) {
  if (item?.file_size > TELEGRAM_DOWNLOAD_LIMIT) {
    return "Telegram Bot API cannot download files larger than 20 MiB";
  }
  return undefined;
}

export function isAddressedMessage(message, botUsername) {
  const expected = String(botUsername || "").replace(/^@/, "").toLowerCase();
  const text = String(message?.text || message?.caption || "").toLowerCase();
  if (expected && [...text.matchAll(/(?:^|[^a-z0-9_])@([a-z0-9_]+)/g)].some(match => match[1] === expected)) return true;
  const repliedTo = String(message?.reply_to_message?.from?.username || "").toLowerCase();
  return Boolean(expected && repliedTo === expected);
}

export function splitTelegramText(text, limit = 3800) {
  const chunks = [];
  let rest = String(text || "").trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function formatRecentHistory(history, limit = 12) {
  return (history || []).slice(-limit)
    .map((item) => `${item.sender || "unknown"}: ${String(item.text || "").slice(0, 4000)}`)
    .join("\n\n");
}

export function telegramRecord(message, eventType = "message") {
  const photos = message.photo || [];
  const items = [
    attachment("document", message.document),
    attachment("photo", photos.at(-1)),
    attachment("video", message.video),
    attachment("audio", message.audio),
    attachment("voice", message.voice),
  ].filter(Boolean);
  return {
    message_id: message.message_id,
    date: message.date,
    edit_date: message.edit_date,
    event_type: eventType,
    media_group_id: message.media_group_id,
    chat_id: message.chat?.id,
    ...(message.message_thread_id != null ? {message_thread_id: message.message_thread_id} : {}),
    sender_id: message.from?.id,
    ...(typeof message.from?.is_bot === 'boolean' ? {sender_is_bot: message.from.is_bot} : {}),
    sender: message.from?.username || message.from?.first_name || String(message.from?.id || "unknown"),
    text: String(message.text || message.caption || ""),
    reply_to_message_id: message.reply_to_message?.message_id,
    ...(message.reply_to_message?.from?.username ? {reply_to_sender: message.reply_to_message.from.username} : {}),
    attachments: items,
  };
}

export function codexInvocation({ sessionId, images = [] }) {
  const common = ["--json", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="low"', "--skip-git-repo-check"];
  const args = sessionId ? ["exec", "resume", ...common] : ["exec", ...common, "--sandbox", "read-only"];
  for (const image of images) args.push("--image", image);
  if (sessionId) args.push(sessionId);
  args.push("-");
  return args;
}

export function parseCodexJson(stdout) {
  let sessionId;
  let answer = "";
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "thread.started") sessionId = event.thread_id || event.thread?.id;
    if (event.type === "item.completed" && event.item?.type === "agent_message") answer = event.item.text || answer;
  }
  return { sessionId, answer };
}
