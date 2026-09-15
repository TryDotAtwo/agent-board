import path from "node:path";

export function parseHistoryGatewayConfig({ raw, env = process.env }) {
  if (!raw) return [];
  const source = JSON.parse(raw).experts;
  if (!Array.isArray(source)) throw new Error("experts configuration is missing");
  const ids = new Set();
  const roots = new Set();
  const tokens = new Set();
  const result = [];
  for (const item of source) {
    const hasRoot = Boolean(item.windows_project_root);
    const hasTokenEnv = Boolean(item.history_token_env);
    if (!hasRoot && !hasTokenEnv) continue;
    if (!hasRoot || !hasTokenEnv) throw new Error(`both history fields are required for ${item.id}`);
    if (!item.id || ids.has(String(item.id))) throw new Error(`duplicate history expert id: ${item.id}`);
    if (!path.win32.isAbsolute(item.windows_project_root)) throw new Error(`history project root must be absolute: ${item.id}`);
    const token = env[item.history_token_env];
    if (!token) throw new Error(`missing history token: ${item.history_token_env}`);
    if (String(token).length < 16) throw new Error(`history token is too short: ${item.history_token_env}`);
    const rootKey = path.win32.resolve(item.windows_project_root).toLowerCase();
    if (roots.has(rootKey)) throw new Error(`duplicate history project root: ${item.windows_project_root}`);
    if (tokens.has(String(token))) throw new Error("duplicate history token");
    ids.add(String(item.id)); roots.add(rootKey); tokens.add(String(token));
    result.push({ expertId: String(item.id), projectRoot: item.windows_project_root, token: String(token) });
  }
  return result;
}

export function historyCredentialsForContainer(options) {
  return Object.fromEntries(parseHistoryGatewayConfig(options).map((item) => [item.expertId, item.token]));
}
