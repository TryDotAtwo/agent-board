function normalize(item, env) {
  if (item.board !== undefined && typeof item.board !== 'boolean') throw new Error('board must be boolean');
  const disabledSkills = item.disabled_skills || [];
  if (!Array.isArray(disabledSkills) || disabledSkills.length > 128 || disabledSkills.some(p =>
    typeof p !== 'string' || !p.startsWith('/') || !p.endsWith('/SKILL.md') || p.includes('/../') || p.includes('\\') || p.includes('\n'))) {
    throw new Error('disabled_skills must contain absolute Linux SKILL.md paths');
  }
  const backend = item.backend || "codex";
  if (!["codex", "desktop-chat"].includes(backend)) throw new Error(`invalid backend for ${item.id}`);
  const token = item.token_env ? env[item.token_env] : item.token;
  if (!token) throw new Error(`Telegram token is missing${item.token_env ? `: ${item.token_env}` : ""}`);
  const accessMode = item.access_mode || "read-only";
  const containerFull = accessMode === 'container-full' && item.id === 'sol_ultra' && item.board === true;
  if (!containerFull && !["read-only", "workspace-write"].includes(accessMode)) throw new Error(`invalid access mode for ${item.id}: ${accessMode}`);
  const toolNamespaces = item.tool_namespaces || [];
  if (!Array.isArray(toolNamespaces) || toolNamespaces.some((name) => !["lean", "vm"].includes(name))) {
    throw new Error(`invalid tool namespace for ${item.id}`);
  }
  const cwd = String(item.cwd || "");
  if (backend === "desktop-chat") {
    if (typeof item.chat_thread_id !== "string" || !item.chat_thread_id.trim() || item.chat_thread_id.length > 256) throw new Error("desktop-chat requires chat_thread_id");
    if (toolNamespaces.length || item.developer_instructions || (item.model && item.model !== "gpt-5-6-pro")) throw new Error("desktop-chat cannot use Codex instructions, tools or a different model");
  }
  if (toolNamespaces.includes("vm") && item.id !== "vm") throw new Error("VM tools may only be configured for expert vm");
  const config = {
    id: String(item.id), token, backend, chatThreadId: item.chat_thread_id,
    board: item.board === true,
    threadConfig: disabledSkills.length ? {'skills.config': [...new Set(disabledSkills)].map(path => ({path, enabled:false}))} : undefined,
    username: String(item.username || "").replace(/^@/, ""),
    chatId: Number(item.chat_id), cwd,
    model: item.model || (backend === "desktop-chat" ? "gpt-5-6-pro" : "gpt-5.6-sol"), effort: item.effort || "low",
    accessMode, sandbox: containerFull ? 'danger-full-access' : accessMode,
    sandboxPolicy: containerFull ? {type:'dangerFullAccess'} : accessMode === "workspace-write"
      ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: true }
      : { type: "readOnly", networkAccess: true },
    developerInstructions: item.developer_instructions || undefined,
    toolNamespaces,
    windowsProjectRoot: item.windows_project_root || undefined,
    historyTokenEnv: item.history_token_env || undefined,
  };
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(config.id)) throw new Error(`invalid expert id: ${config.id}`);
  if (!config.username || !Number.isSafeInteger(config.chatId) || (backend === "codex" && !config.cwd)) throw new Error(`invalid config for ${config.id}`);
  return config;
}

export function parseExpertConfigs({ raw, env = process.env }) {
  const source = raw ? JSON.parse(raw).experts : [{
    id: "default", token: env.TELEGRAM_BOT_TOKEN,
    username: env.TELEGRAM_BOT_USERNAME,
    chat_id: env.TELEGRAM_CHAT_ID,
    cwd: env.PROJECT_CWD,
    model: env.CODEX_MODEL || "gpt-5.6-sol",
    effort: env.CODEX_REASONING_EFFORT || "low",
  }];
  if (!Array.isArray(source) || source.length === 0) throw new Error("experts configuration is empty");
  const ids = new Set();
  return source.map((item) => {
    if (ids.has(String(item.id))) throw new Error(`duplicate expert id: ${item.id}`);
    ids.add(String(item.id));
    return normalize(item, env);
  });
}
